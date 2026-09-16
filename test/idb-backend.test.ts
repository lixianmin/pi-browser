// @vitest-environment node
// Plan 7b T6a 平移：pi FileSystem 适配器（lightning-fs/IDB 后端）契约单测。
// 与 test/memory-backend.test.ts 同断言集：同一份契约跑两个后端（spec §3 测试 1）。
// 这里 import './helpers/idb' 注入 fake-indexeddb，并显式传 `memory: false`（偏离①：强制直达
// lightning-fs，不看 VITEST 自动内存判定）——否则这批断言会静默退回内存后端，IDB 路径等于没测。
import './helpers/idb';
import { describe, it, expect, beforeEach } from 'vitest';
import { createBrowserFileSystem } from '../src/env/backend-idb';
import { BACKGROUND_CONTEXT, type FileInfo } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../src/env/types';

const CTX = BACKGROUND_CONTEXT;   // pi 的方法都要 chord Context；BACKGROUND_CONTEXT 是 pi 现成的背景上下文
let fs: BrowserFileSystem;
beforeEach(() => { fs = createBrowserFileSystem({ dbName: `test-${Math.random().toString(36).slice(2)}`, memory: false }); });

const getOrFail = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
	if (!r.ok) throw new Error(`expected ok, got error: ${r.error.message}`);
	return r.value;
};

describe('createBrowserFileSystem：路径与读写（Plan 7b T6a）', () => {
	it('绝对/相对路径归一化；joinPath 解析 . 与 ..', async () => {
		expect(fs.cwd).toBe('/');
		expect(getOrFail(await fs.absolutePath('a/b.txt', CTX))).toBe('/a/b.txt');
		expect(getOrFail(await fs.joinPath(['/a', 'b', '..', 'c.txt'], CTX))).toBe('/a/c.txt');
		expect(getOrFail(await fs.canonicalPath('./x/./y', CTX))).toBe('/x/y');
	});

	it('writeFile 自动建父目录；readTextFile 读回原文', async () => {
		expect((await fs.writeFile('/sessions/s1/entries.jsonl', 'hello\n', CTX)).ok).toBe(true);
		expect(getOrFail(await fs.readTextFile('/sessions/s1/entries.jsonl', CTX))).toBe('hello\n');
	});

	it('writeFile 二进制 + readBinaryFile 往返', async () => {
		const bytes = new Uint8Array([1, 2, 3, 255]);
		await fs.writeFile('/b.bin', bytes, CTX);
		expect([...getOrFail(await fs.readBinaryFile('/b.bin', CTX))]).toEqual([1, 2, 3, 255]);
	});

	it('readTextLines 按 \\n 切行并遵守 maxLines', async () => {
		await fs.writeFile('/lines.txt', 'l1\nl2\nl3\nl4', CTX);
		expect(getOrFail(await fs.readTextLines('/lines.txt', undefined, CTX))).toEqual(['l1', 'l2', 'l3', 'l4']);
		expect(getOrFail(await fs.readTextLines('/lines.txt', { maxLines: 2 }, CTX))).toEqual(['l1', 'l2']);
	});

	it('appendFile 追加（lightning-fs 无 append → 读改写）；文件不存在时等同新建', async () => {
		await fs.appendFile('/log.jsonl', '{a}\n', CTX);
		await fs.appendFile('/log.jsonl', '{b}\n', CTX);
		expect(getOrFail(await fs.readTextFile('/log.jsonl', CTX))).toBe('{a}\n{b}\n');
	});

	it('renameFile 覆盖目标并保留内容；目标父目录自动创建', async () => {
		await fs.writeFile('/old.jsonl', 'v1', CTX);
		await fs.writeFile('/dest/new.jsonl', 'old', CTX);
		await fs.renameFile('/old.jsonl', '/dest/new.jsonl', CTX);
		expect(getOrFail(await fs.readTextFile('/dest/new.jsonl', CTX))).toBe('v1');
		expect(getOrFail(await fs.exists('/old.jsonl', CTX))).toBe(false);
	});
});

describe('createBrowserFileSystem：目录、存在性与错误映射（Plan 7b T6a）', () => {
	it('fileInfo / listDir：区分 file 与 directory，返回 name/size/mtimeMs', async () => {
		await fs.writeFile('/dir/a.txt', 'x', CTX);
		await fs.writeFile('/dir/sub/b.txt', 'yy', CTX);
		const info = getOrFail(await fs.fileInfo('/dir', CTX));
		expect(info).toMatchObject({ name: 'dir', kind: 'directory' });
		const children = getOrFail(await fs.listDir('/dir', CTX)) as FileInfo[];
		expect(children.map((c) => `${c.name}:${c.kind}`).sort()).toEqual(['a.txt:file', 'sub:directory']);
		const file = getOrFail(await fs.fileInfo('/dir/a.txt', CTX));
		expect(file.kind).toBe('file');
		expect(file.size).toBe(1);
	});

	it('exists：存在 true / 不存在 false（含「路径穿过一个文件」——lightning-fs 会误判存在，适配层逐段校验）', async () => {
		await fs.writeFile('/f.txt', 'x', CTX);
		expect(getOrFail(await fs.exists('/f.txt', CTX))).toBe(true);
		expect(getOrFail(await fs.exists('/nope.txt', CTX))).toBe(false);
		expect(getOrFail(await fs.exists('/f.txt/child', CTX))).toBe(false);   // 不带子文件的路径
		// fileInfo 对这类路径给 not_found（不返回文件本身的 stat）
		const info = await fs.fileInfo('/f.txt/child', CTX);
		expect(info.ok).toBe(false);
		expect(info.ok === false && info.error.code).toBe('not_found');
	});

	it('读不存在的文件 → not_found（FileError，不抛）', async () => {
		const r = await fs.readTextFile('/missing.txt', CTX);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.error.code).toBe('not_found');
		expect(r.ok === false && r.error.path).toBe('/missing.txt');
	});

	it('createDir recursive 幂等；remove 文件 / 目录（recursive）', async () => {
		expect((await fs.createDir('/a/b/c', { recursive: true }, CTX)).ok).toBe(true);
		expect((await fs.createDir('/a/b/c', { recursive: true }, CTX)).ok).toBe(true);   // 幂等
		await fs.writeFile('/a/b/c/x.txt', '1', CTX);
		await fs.remove('/a/b/c/x.txt', undefined, CTX);
		expect(getOrFail(await fs.exists('/a/b/c/x.txt', CTX))).toBe(false);
		await fs.remove('/a', { recursive: true }, CTX);
		expect(getOrFail(await fs.exists('/a', CTX))).toBe(false);
		// force：删不存在的路径视为成功
		expect((await fs.remove('/a', { recursive: true, force: true }, CTX)).ok).toBe(true);
	});

	it('createTempDir / createTempFile 返回可用路径；cleanup 不抛', async () => {
		const dir = getOrFail(await fs.createTempDir(undefined, CTX));
		expect(getOrFail(await fs.fileInfo(dir, CTX)).kind).toBe('directory');
		const file = getOrFail(await fs.createTempFile({ prefix: 'p-', suffix: '.jsonl' }, CTX));
		expect(file).toMatch(/^\/tmp\/p-.*\.jsonl$/);
		expect(getOrFail(await fs.fileInfo(file, CTX)).kind).toBe('file');
		await expect(fs.cleanup(CTX)).resolves.toBeUndefined();
	});
});

describe('错误码针对性覆盖（复审 P1：not_directory）', () => {
	it('listDir 穿过文件 → not_directory（FileError，不抛）', async () => {
		await fs.writeFile('/f.txt', 'x', CTX);
		const r = await fs.listDir('/f.txt', CTX);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.error.code).toBe('not_directory');
	});
});
