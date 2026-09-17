// @vitest-environment node
// worker 路径 exec 收尾的「推 − 拉」对账回归（真适配器 + 真挂载表，不起真 Worker）。
//
// 缺陷（2026-09-17 实测复现）：worker 回传的是适配器的 **drain**（`exportChanges()`：导出即把当前树立为新基线），
// 而收尾对账把它当**全量快照**用（`alive = 拉回来的`）。只要本次 exec 里跑过一次宿主命令
// （`createGuestHostBuiltins` 会 drain 一次），收尾那次 drain 就是空差集 ⇒ `alive` 空 ⇒
// 宿主 store 里整棵 `/workspace` 被 `remove(recursive)` 删掉，而 exec 仍返回 ok。
// 修法：worker 的 PULL_CHANGES 回 `snapshot()`（非 drain 的全量快照），对账的全量前提才真正成立。
import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import { createWasiFileSystem, readMountTree, type WasiFileSystem, type WasiFsChanges } from '../src/shell/wasi-fs';
import { applyChanges } from '../src/shell/sync-session';
import { reconcilePulled } from '../src/shell/exec';

const CTX = BACKGROUND_CONTEXT;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const getOrFail = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
	if (!r.ok) throw new Error(`expected ok: ${r.error.code}`);
	return r.value;
};

/** 复刻 wasi-sh 的 `seedInto`：按文件的父目录逐级 mkdir -p（这是 worker 拿到树、也是 cwd 存在的唯一途径） */
function seedInto(fs: WasiFileSystem, files: Record<string, string | Uint8Array>): void {
	const present = (path: string): boolean => { try { fs.statSync(path); return true; } catch { return false; } };
	for (const [path, content] of Object.entries(files)) {
		const segments = path.split('/').filter(Boolean);
		let dir = '';
		for (let i = 0; i < segments.length - 1; i++) {
			dir = `${dir}/${segments[i]}`;
			if (!present(dir)) fs.mkdirSync(dir, { mode: 0o755, uid: 0, gid: 0 });
		}
		if (!present(path)) fs.createFileSync(path, { mode: 0o644, uid: 0, gid: 0 });
		const bytes = typeof content === 'string' ? enc(content) : content;
		if (bytes.length) fs.writeSync(path, bytes, 0);
		fs.touchSync(path, { size: bytes.length });
	}
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
/** 宿主处理器引起净变化的等价物（exec 的 `diffTree` 同形：只报新增/改动的文件、新目录） */
const netChanges = (before: WasiFsChanges, after: WasiFsChanges): WasiFsChanges => ({
	deleted: [],
	dirs: after.dirs.filter((d) => !before.dirs.includes(d)),
	written: after.written.filter((w) => {
		const prev = before.written.find((b) => b.path === w.path);
		return !prev || !sameBytes(prev.data, w.data);
	}),
});

describe('WasiFileSystem.snapshot（非 drain 的全量快照）', () => {
	/** worker 里的真实形状：适配器 mounts 为空，树只经 `seedInto`（spawn 的 files）进来 */
	const guestWith = (files: Record<string, string>): WasiFileSystem => {
		const guest = createWasiFileSystem({ mounts: [] });
		seedInto(guest, files);
		return guest;
	};

	it('返回当前全树（目录 + 文件），且不推进 drain 基线', () => {
		const guest = guestWith({ '/root/a.txt': 'A', '/root/sub/b.txt': 'B' });
		const snap = guest.snapshot();
		expect(snap.deleted).toEqual([]);
		expect(snap.dirs).toEqual(expect.arrayContaining(['/root', '/root/sub']));
		expect(snap.written.map((w) => w.path).sort()).toEqual(['/root/a.txt', '/root/sub/b.txt']);

		// 非 drain：快照之后 exportChanges 仍报出「相对基线」的同一份内容（基线没被快照推进）
		const drained = guest.exportChanges();
		expect(drained.written.map((w) => w.path).sort()).toEqual(['/root/a.txt', '/root/sub/b.txt']);
	});

	it('基线被 drain 推进之后，快照仍返回全树（这正是修复点）', () => {
		const guest = guestWith({ '/root/a.txt': 'A', '/root/sub/b.txt': 'B' });
		expect(guest.exportChanges().written).toHaveLength(2);   // 宿主命令的 drain 把基线推到当前树
		expect(guest.exportChanges().written).toEqual([]);       // 证明基线真被推进了（drain 是空的）
		const snap = guest.snapshot();
		expect(snap.written.map((w) => w.path).sort()).toEqual(['/root/a.txt', '/root/sub/b.txt']);
	});
});

describe('worker 路径 exec 收尾对账', () => {
	/** 复刻 execInWorker 的三步：spawn 推树 → 宿主命令往返 → 收尾 requestChanges + pulledChanges + applyChanges */
	async function runScenario(withHostCommand: boolean): Promise<{ host: BrowserFileSystem; deleted: string[] }> {
		const host = createMemoryFileSystem();
		const store = { mounts: [{ prefix: '/', fs: host }] };
		await host.writeFile('/workspace/keep.txt', 'hello', CTX);
		await host.writeFile('/workspace/project/sketch.ino', 'void loop(){}', CTX);

		const pushed = await readMountTree(store);
		const files: Record<string, string | Uint8Array> = {};
		for (const { path, data } of pushed.written) files[path] = data;

		const guest = createWasiFileSystem({ mounts: [] });
		seedInto(guest, files);

		if (withHostCommand) {
			await applyChanges(store, guest.exportChanges());                       // guest 变更 → 权威 store
			const before = await readMountTree(store);
			await host.writeFile('/workspace/repo/.git/HEAD', 'ref: refs/heads/master\n', CTX);   // 处理器写 .git
			guest.applyChanges(netChanges(before, await readMountTree(store)));     // 净变化回传 guest
		}

		const pulled = guest.snapshot();                                            // worker 的 PULL_CHANGES 回传
		const reconciled = reconcilePulled(pushed, pulled);
		await applyChanges(store, reconciled);
		return { host, deleted: reconciled.deleted };
	}

	it('没跑过宿主命令：工作区完整保留', async () => {
		const { host, deleted } = await runScenario(false);
		expect(deleted).toEqual([]);
		expect(getOrFail(await host.exists('/workspace/keep.txt', CTX))).toBe(true);
	});

	it('跑过宿主命令（drain 已推进基线）：工作区仍完整保留，.git 落盘', async () => {
		const { host, deleted } = await runScenario(true);
		expect(deleted).toEqual([]);
		expect(getOrFail(await host.exists('/workspace/keep.txt', CTX))).toBe(true);
		const head = await host.readTextFile('/workspace/repo/.git/HEAD', CTX);
		expect(head.ok && dec(enc(head.value)) === head.value).toBe(true);
	});
});

describe('worker 模块的回传契约', () => {
	// worker.ts import 时会执行 wasi-sh 的 `serve()`（要 `self`），node 下起不来 ⇒ 这一行只能锁源码。
	// 它正是本次事故的开关：回 drain 会让收尾对账把整棵工作区当成已删除。
	it('PULL_CHANGES 用 snapshot() 而不是 exportChanges()', async () => {
		const src = await readFile(new URL('../src/shell/worker.ts', import.meta.url), 'utf8');
		expect(src).toContain('store.snapshot()');
		expect(src).not.toContain('store.exportChanges()');
	});
});
