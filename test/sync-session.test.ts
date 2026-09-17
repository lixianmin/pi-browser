// @vitest-environment node
// spec §3.2/§4.1：run 边界的单写者同步（seed / pullAndApply）+ 三条验收（双向 + 两次会话串行）。
import { describe, it, expect, vi } from 'vitest';
import { BACKGROUND_CONTEXT, type FileError, type Result } from '@earendil-works/pi-agent-core';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import { createSyncSession } from '../src/shell/sync-session';

const CTX = BACKGROUND_CONTEXT;
const NEW_DIR = { mode: 0o755, uid: 0, gid: 0 };
const NEW_FILE = { mode: 0o644, uid: 0, gid: 0 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const getOrFail = <T>(r: Result<T, FileError>): T => {
	if (!r.ok) throw new Error(`expected ok: ${r.error.code} ${r.error.message}`);
	return r.value;
};
/** guest 侧写一个文件（wasi-sh 的 store 是同步 API：先 create 再位置写） */
const guestWrite = (fs: { createFileSync: (p: string, o: typeof NEW_FILE) => unknown; writeSync: (p: string, b: Uint8Array, o: number) => void }, path: string, text: string): void => {
	fs.createFileSync(path, NEW_FILE);
	fs.writeSync(path, enc(text), 0);
};
const guestRead = (fs: { statSync: (p: string) => { size: number }; readSync: (p: string, b: Uint8Array, s: number, e: number) => void }, path: string): string => {
	const { size } = fs.statSync(path);
	const buf = new Uint8Array(size);
	if (size) fs.readSync(path, buf, 0, size);
	return dec(buf);
};


describe('run 边界同步', () => {
	it('① seed → guest 写 → pullAndApply → 宿主 fs 读回（含新建目录与删除）', async () => {
		const root = createMemoryFileSystem();
		getOrFail(await root.writeFile('/gone.txt', 'x', CTX));
		const session = createSyncSession({ mounts: [{ prefix: '/', fs: root }] });
		await session.seed();

		guestWrite(session.guestFs, '/a.txt', 'from guest');
		session.guestFs.mkdirSync('/d', NEW_DIR);
		guestWrite(session.guestFs, '/d/b.txt', 'nested');
		session.guestFs.unlinkSync('/gone.txt');

		await session.pullAndApply();
		expect(getOrFail(await root.readTextFile('/a.txt', CTX))).toBe('from guest');
		expect(getOrFail(await root.readTextFile('/d/b.txt', CTX))).toBe('nested');
		expect(getOrFail(await root.fileInfo('/d', CTX)).kind).toBe('directory');
		expect(getOrFail(await root.exists('/gone.txt', CTX))).toBe(false);

		// 第二次 pull 没有新变更（drain 语义：不会重复回写）
		const flushSpy = vi.spyOn(root, 'flush');
		await session.pullAndApply();
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(getOrFail(await root.readTextFile('/a.txt', CTX))).toBe('from guest');
	});

	it('② 宿主 fs 先写 → seed → guest 读到（另一方向）', async () => {
		const root = createMemoryFileSystem();
		getOrFail(await root.writeFile('/js.txt', 'from js', CTX));
		getOrFail(await root.createDir('/empty', { recursive: true }, CTX));
		const session = createSyncSession({ mounts: [{ prefix: '/', fs: root }] });

		await session.seed();
		expect(guestRead(session.guestFs, '/js.txt')).toBe('from js');
		expect(session.guestFs.statSync('/js.txt').size).toBe(7);
		expect(session.guestFs.readdirSync('/').sort()).toEqual(['empty', 'js.txt', 'tmp']);
	});

	it('③ 两次会话串行：前一回合的写入不回退、不丢', async () => {
		const root = createMemoryFileSystem();
		const first = createSyncSession({ mounts: [{ prefix: '/', fs: root }] });
		await first.seed();
		guestWrite(first.guestFs, '/one.txt', '1');
		await first.pullAndApply();

		const second = createSyncSession({ mounts: [{ prefix: '/', fs: root }] });
		await second.seed();
		expect(guestRead(second.guestFs, '/one.txt')).toBe('1');
		guestWrite(second.guestFs, '/two.txt', '2');
		second.guestFs.unlinkSync('/one.txt');
		await second.pullAndApply();

		expect(getOrFail(await root.readTextFile('/two.txt', CTX))).toBe('2');
		expect(getOrFail(await root.exists('/one.txt', CTX))).toBe(false);
	});

	it('跨挂载：变更按最长前缀路由回各自后端（/tmp 不写进 / 后端）', async () => {
		const root = createMemoryFileSystem();
		const tmp = createMemoryFileSystem();
		const session = createSyncSession({ mounts: [{ prefix: '/', fs: root }, { prefix: '/tmp', fs: tmp }] });
		await session.seed();

		guestWrite(session.guestFs, '/a.txt', 'A');
		guestWrite(session.guestFs, '/tmp/x.txt', 'X');
		await session.pullAndApply();

		expect(getOrFail(await tmp.readTextFile('/tmp/x.txt', CTX))).toBe('X');
		expect(getOrFail(await root.readTextFile('/a.txt', CTX))).toBe('A');
		expect(getOrFail(await root.exists('/tmp/x.txt', CTX))).toBe(false);   // 没落到 / 后端（否则是刷新即丢数据的一类 bug）
	});
});
