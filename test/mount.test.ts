// @vitest-environment node
// spec §3 测试：MountTable 路由（先归一后分派 / 段边界 / 最长前缀 / temp 固定投递 / 跨 mount 拒绝 / 挂载根合成）。
// 探测技巧：两个内存后端当探针——各自写入不同内容，断言读到谁的等于断言路由到了谁（内存后端各持一份 Map）。
import { describe, it, expect, beforeEach } from 'vitest';
import { BACKGROUND_CONTEXT, type FileError, type Result } from '@earendil-works/pi-agent-core';
import { createMountTable, type MountTable } from '../src/env/mount';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';

const CTX = BACKGROUND_CONTEXT;
const getOrFail = <T>(r: Result<T, FileError>): T => {
	if (!r.ok) throw new Error(`expected ok, got error: ${r.error.code} ${r.error.message}`);
	return r.value;
};

let root: BrowserFileSystem;   // 探针 A：扮演 '/' 挂载（默认表里是 lightning-fs/IDB）
let tmp: BrowserFileSystem;    // 探针 B：扮演 '/tmp' 挂载（默认表里是内存）
let table: MountTable;
beforeEach(() => {
	root = createMemoryFileSystem();
	tmp = createMemoryFileSystem();
	table = createMountTable([{ prefix: '/', fs: root }, { prefix: '/tmp', fs: tmp }]);
});

describe('createMountTable：前缀分派', () => {
	it('归一先于分派：/tmp/../b.txt 走 / 挂载（不是 /tmp）', async () => {
		expect((await root.writeFile('/b.txt', 'root-b', CTX)).ok).toBe(true);
		// 若先分派后归一，'/tmp/../b.txt' 会先进 /tmp 挂载 → 在那里 not_found
		expect(getOrFail(await table.readTextFile('/tmp/../b.txt', CTX))).toBe('root-b');
	});

	it('段边界：/tmpfoo 不进 /tmp 挂载', async () => {
		expect((await root.writeFile('/tmpfoo', 'root-tmpfoo', CTX)).ok).toBe(true);
		expect((await tmp.writeFile('/tmpfoo', 'tmp-tmpfoo', CTX)).ok).toBe(true);
		expect(getOrFail(await table.readTextFile('/tmpfoo', CTX))).toBe('root-tmpfoo');
	});

	it('最长前缀优先：/tmp/x 走 /tmp 挂载而非 /', async () => {
		expect((await root.writeFile('/tmp/x', 'root-x', CTX)).ok).toBe(true);
		expect((await tmp.writeFile('/tmp/x', 'tmp-x', CTX)).ok).toBe(true);
		expect(getOrFail(await table.readTextFile('/tmp/x', CTX))).toBe('tmp-x');
	});

	it('cwd 取 entries[0] 的 cwd；roots() 给挂载顶层名', () => {
		expect(table.cwd).toBe('/');
		expect(table.roots()).toEqual(['tmp']);
	});
});

describe('createMountTable：临时件固定投 /tmp', () => {
	it('createTempDir 落在 /tmp 挂载（不在 / 挂载），且 listDir(/tmp) 能看到', async () => {
		const dir = getOrFail(await table.createTempDir(undefined, CTX));
		expect(dir.startsWith('/tmp/')).toBe(true);
		expect(getOrFail(await tmp.exists(dir, CTX))).toBe(true);
		expect(getOrFail(await root.exists(dir, CTX))).toBe(false);   // 没落到 '/' 挂载
		const names = getOrFail(await table.listDir('/tmp', CTX)).map((i) => i.path);
		expect(names).toContain(dir);
	});

	it('createTempFile 落在 /tmp 挂载，内容可读回', async () => {
		const file = getOrFail(await table.createTempFile({ prefix: 'p-', suffix: '.txt' }, CTX));
		expect(file.startsWith('/tmp/p-')).toBe(true);
		expect(file.endsWith('.txt')).toBe(true);
		expect(getOrFail(await tmp.exists(file, CTX))).toBe(true);
		expect(getOrFail(await table.readTextFile(file, CTX))).toBe('');
	});
});

describe('createMountTable：跨 mount 与挂载根合成', () => {
	it('跨挂载点 renameFile → not_supported（浏览器侧语义，Node 同场景落 unknown）', async () => {
		expect((await root.writeFile('/a.txt', 'v1', CTX)).ok).toBe(true);
		const r = await table.renameFile('/a.txt', '/tmp/b.txt', CTX);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe('not_supported');
		expect(getOrFail(await table.exists('/tmp/b.txt', CTX))).toBe(false);
		expect(getOrFail(await table.exists('/a.txt', CTX))).toBe(true);   // 源文件没被动
	});

	it('listDir(/) 合成挂载根：/ 挂载子项 ∪ 挂载顶层名', async () => {
		expect((await root.writeFile('/root-child.txt', 'x', CTX)).ok).toBe(true);
		expect((await root.createDir('/spice-sessions', { recursive: true }, CTX)).ok).toBe(true);
		expect((await tmp.writeFile('/tmp/t.txt', 'x', CTX)).ok).toBe(true);
		const entries = getOrFail(await table.listDir('/', CTX));
		expect(entries.map((i) => i.name)).toEqual(['root-child.txt', 'spice-sessions', 'tmp']);
		expect(entries[2]).toEqual({ name: 'tmp', path: '/tmp', kind: 'directory', size: 0, mtimeMs: 0 });
	});

	it('fileInfo/exists(/tmp) 由表应答（空挂载点也成立，不打到后端）', async () => {
		const info = getOrFail(await table.fileInfo('/tmp', CTX));
		expect(info).toEqual({ name: 'tmp', path: '/tmp', kind: 'directory', size: 0, mtimeMs: 0 });
		expect(getOrFail(await table.exists('/tmp', CTX))).toBe(true);
		// 探针：/tmp 挂载里什么都没写过，委托后端会得 not_found → 说明是表应答的
		expect((await tmp.fileInfo('/tmp', CTX)).ok).toBe(false);
	});
});
