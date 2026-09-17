// @vitest-environment node
// spec §3.1/§4.1：createWasiFileSystem —— wasi-sh `FileSystem` 的同步适配器。
// 验收 = wasi-sh 自带的 fs/conformance 套件全绿（21 条，上游对「store 必须做到什么」的权威清单）
// + 往返（适配器写 → 变更集 → 宿主 fs → 新适配器 seed 读回）+ ino 会话内稳定。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, type FileError, type Result } from '@earendil-works/pi-agent-core';
import { conformanceCases } from 'wasi-sh/fs/conformance';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import { createWasiFileSystem, readMountTree, type WasiFileSystem, type WasiFsChanges } from '../src/shell/wasi-fs';

const CTX = BACKGROUND_CONTEXT;
const NEW_DIR = { mode: 0o755, uid: 0, gid: 0 };
const NEW_FILE = { mode: 0o644, uid: 0, gid: 0 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const getOrFail = <T>(r: Result<T, FileError>): T => {
	if (!r.ok) throw new Error(`expected ok: ${r.error.code} ${r.error.message}`);
	return r.value;
};
const readAll = (fs: WasiFileSystem, path: string): string => {
	const { size } = fs.statSync(path);
	const buf = new Uint8Array(size);
	if (size) fs.readSync(path, buf, 0, size);
	return dec(buf);
};
/** 覆盖写（writeSync 是位置写，不截断——要改内容短的先 touch 到 0） */
const overwrite = (fs: WasiFileSystem, path: string, text: string): void => {
	fs.touchSync(path, { size: 0 });
	fs.writeSync(path, enc(text), 0);
};

describe('wasi-sh fs/conformance', () => {
	for (const [i, testCase] of conformanceCases().entries()) {
		it(testCase.name, () => {
			// 每条用例一个新 store：失败不级联，且用例只碰自己那个目录（上游跑法同）
			const fs = createWasiFileSystem({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }] });
			testCase.run(fs, `/conformance-${i}`);
		});
	}
});

describe('readMountTree：挂载树 → 变更集形状', () => {
	it('递归读出文件与目录（deleted 恒空，dirs 父先于子）', async () => {
		const host = createMemoryFileSystem();
		getOrFail(await host.writeFile('/a.txt', 'A', CTX));
		getOrFail(await host.createDir('/d/sub', { recursive: true }, CTX));
		getOrFail(await host.writeFile('/d/sub/b.txt', 'B', CTX));
		const tree = await readMountTree({ mounts: [{ prefix: '/', fs: host }] });
		expect(tree.deleted).toEqual([]);
		expect(tree.dirs).toEqual(['/d', '/d/sub']);
		expect(tree.written.map((w) => [w.path, dec(w.data)])).toEqual([['/a.txt', 'A'], ['/d/sub/b.txt', 'B']]);
	});
});

describe('变更集往返（run 边界的两个方向）', () => {
	/** 把变更集写回宿主 fs：等价于 sync-session 的 pullAndApply（这里刻意就地写，证明变更集本身自足） */
	const applyToHost = async (host: BrowserFileSystem, changes: WasiFsChanges): Promise<void> => {
		for (const path of changes.deleted) getOrFail(await host.remove(path, { recursive: true, force: true }, CTX));
		for (const path of changes.dirs) getOrFail(await host.createDir(path, { recursive: true }, CTX));
		for (const { path, data } of changes.written) getOrFail(await host.writeFile(path, data, CTX));
	};

	it('guest 写 → exportChanges → 宿主 fs → 新适配器 seed 读回', async () => {
		const host = createMemoryFileSystem();
		getOrFail(await host.writeFile('/keep.txt', 'before', CTX));
		getOrFail(await host.writeFile('/gone.txt', 'x', CTX));

		const guest = createWasiFileSystem({ mounts: [{ prefix: '/', fs: host }] });
		await guest.seed();
		expect(guest.exportChanges()).toEqual({ deleted: [], dirs: [], written: [] });   // seed 即基线

		overwrite(guest, '/keep.txt', 'after');
		guest.mkdirSync('/newdir', NEW_DIR);
		guest.createFileSync('/newdir/f.txt', NEW_FILE);
		guest.writeSync('/newdir/f.txt', enc('hi'), 0);
		guest.unlinkSync('/gone.txt');

		const changes = guest.exportChanges();
		expect(changes.deleted).toEqual(['/gone.txt']);
		expect(changes.dirs).toEqual(['/newdir']);
		expect(changes.written.map((w) => [w.path, dec(w.data)])).toEqual([['/keep.txt', 'after'], ['/newdir/f.txt', 'hi']]);
		expect(guest.exportChanges()).toEqual({ deleted: [], dirs: [], written: [] });   // drain：导出即立新基线

		await applyToHost(host, changes);
		expect(getOrFail(await host.readTextFile('/keep.txt', CTX))).toBe('after');
		expect(getOrFail(await host.readTextFile('/newdir/f.txt', CTX))).toBe('hi');
		expect(getOrFail(await host.exists('/gone.txt', CTX))).toBe(false);

		const rehydrated = createWasiFileSystem({ mounts: [{ prefix: '/', fs: host }] });
		await rehydrated.seed();
		expect(readAll(rehydrated, '/keep.txt')).toBe('after');
		expect(readAll(rehydrated, '/newdir/f.txt')).toBe('hi');
		expect(rehydrated.readdirSync('/').sort()).toEqual(['keep.txt', 'newdir', 'tmp']);
		expect(rehydrated.exportChanges()).toEqual({ deleted: [], dirs: [], written: [] });
	});

	it('第二次会话（新适配器）不把上一轮的写入当成新变更', async () => {
		const host = createMemoryFileSystem();
		const first = createWasiFileSystem({ mounts: [{ prefix: '/', fs: host }] });
		await first.seed();
		first.createFileSync('/one.txt', NEW_FILE);
		first.writeSync('/one.txt', enc('1'), 0);
		await applyToHost(host, first.exportChanges());

		const second = createWasiFileSystem({ mounts: [{ prefix: '/', fs: host }] });
		await second.seed();
		expect(second.exportChanges()).toEqual({ deleted: [], dirs: [], written: [] });
		second.createFileSync('/two.txt', NEW_FILE);
		second.writeSync('/two.txt', enc('2'), 0);
		expect(second.exportChanges().written.map((w) => w.path)).toEqual(['/two.txt']);
		expect(getOrFail(await host.readTextFile('/one.txt', CTX))).toBe('1');   // 上一轮的内容没被丢/改写
	});

	it('rename 保 ino（会话内稳定），目录子树跟着走', () => {
		const fs = createWasiFileSystem({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }] });
		fs.mkdirSync('/a', NEW_DIR);
		fs.createFileSync('/a/f', NEW_FILE);
		const ino = fs.statSync('/a/f').ino;
		fs.renameSync('/a', '/b');
		expect(fs.statSync('/b/f').ino).toBe(ino);
		expect(fs.readdirSync('/b')).toEqual(['f']);
	});
});
