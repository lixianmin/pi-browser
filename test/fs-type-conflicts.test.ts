// @vitest-environment node
// 目录 / 文件**类型冲突**的契约对齐（vs 上游 `NodeExecutionEnv`）。
//
// 为什么单列一个文件：这批不是"错误码风格"差异，而是**数据损坏级**的 bug——
// memory 后端的 `writeFile` / `appendFile` / `createDir` / `renameFile` 直接 `files.set()`
// 覆盖节点，一个目录或文件被静默换成另一个；两个后端的读路径又把目录报成 `not_found`
// 而不是上游的 `is_directory`。调用方按错误码分支（比如 `read` 工具把 `not_found` 当
// "文件不存在"继续走建文件分支）就会把目录覆盖掉。
//
// 上游口径（`NodeExecutionEnv` 实测）：
//   readTextFile / readBinaryFile / openTextLineReader / truncateFile / flushFile / appendFile / writeFile 对目录 → is_directory
//   createDir 对已存在文件 → unknown（ERR_FS_EEXIST？）；spec §3 要求可归类失败不落 unknown → 本仓落 invalid
//   renameFile 目标是目录 → is_directory
//   createDir(recursive:false) 父目录缺失 → not_found
import './helpers/idb';
import { describe, it, expect } from 'vitest';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import type { BrowserFileSystem } from '../src/env/types';
import { createBrowserFileSystem } from '../src/env/backend-idb';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const CTX = BACKGROUND_CONTEXT;
const code = (r: { ok: true; value: unknown } | { ok: false; error: { code: string } }) => (r.ok ? 'ok' : r.error.code);
const fail = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
	if (!r.ok) throw new Error(`expected ok: ${r.error.code}`);
	return r.value;
};

/** 同一套断言跑两个浏览器后端（契约共享，实现两份）。 */
const backends: [string, () => BrowserFileSystem][] = [
	['memory', () => createMemoryFileSystem('/')],
	['idb', () => createBrowserFileSystem({ dbName: `tc-${Math.random().toString(36).slice(2)}`, memory: false })],
];

/** 铺好 `/d`（目录）与 `/f`（文件，内容 'x'）两个探针。 */
async function seed(fs: BrowserFileSystem): Promise<void> {
	await fs.createDir('/d', undefined, CTX);
	await fs.writeFile('/f', 'x', CTX);
}

describe.each(backends)('类型冲突：%s 后端', (_name, make) => {
	it('读路径对目录报 is_directory（不是 not_found）', async () => {
		const fs = make();
		await seed(fs);
		expect(code(await fs.readTextFile('/d', CTX))).toBe('is_directory');
		expect(code(await fs.readBinaryFile('/d', CTX))).toBe('is_directory');
		expect(code(await fs.openTextLineReader('/d', CTX))).toBe('is_directory');
		expect(code(await fs.truncateFile('/d', 1, CTX))).toBe('is_directory');
		expect(code(await fs.flushFile('/d', CTX))).toBe('is_directory');
	});

	it('appendFile 对目录报 is_directory，且目录**没有被覆盖成文件**', async () => {
		const fs = make();
		await seed(fs);
		expect(code(await fs.appendFile('/d', 'boom', CTX))).toBe('is_directory');
		expect(fail(await fs.fileInfo('/d', CTX)).kind).toBe('directory');
	});

	it('writeFile 对目录报 is_directory，且目录**没有被覆盖成文件**', async () => {
		const fs = make();
		await seed(fs);
		expect(code(await fs.writeFile('/d', 'boom', CTX))).toBe('is_directory');
		expect(fail(await fs.fileInfo('/d', CTX)).kind).toBe('directory');
	});

	it('createDir 对已存在文件报 invalid，且文件**没有被覆盖成目录**', async () => {
		const fs = make();
		await seed(fs);
		// 上游是 unknown（EEXIST → toFileError 无分支），spec §3 禁止对齐 unknown → 本仓落 invalid
		expect(code(await fs.createDir('/f', { recursive: true }, CTX))).toBe('invalid');
		expect(code(await fs.createDir('/f', { recursive: false }, CTX))).toBe('invalid');
		expect(fail(await fs.fileInfo('/f', CTX)).kind).toBe('file');
		expect(fail(await fs.readTextFile('/f', CTX))).toBe('x');
	});

	it('renameFile 目标是目录报 is_directory，且目录**没有被覆盖**、源文件仍在', async () => {
		const fs = make();
		await seed(fs);
		expect(code(await fs.renameFile('/f', '/d', CTX))).toBe('is_directory');
		expect(fail(await fs.fileInfo('/d', CTX)).kind).toBe('directory');
		expect(fail(await fs.exists('/f', CTX))).toBe(true);
	});

	it('createDir(recursive:false) 父目录缺失报 not_found，且**不偷偷建父目录**', async () => {
		const fs = make();
		await fs.createDir('/only', undefined, CTX);
		expect(code(await fs.createDir('/only/a/b', { recursive: false }, CTX))).toBe('not_found');
		expect(fail(await fs.exists('/only/a', CTX))).toBe(false);
	});

	it('readTextLines 对目录报 is_directory', async () => {
		const fs = make();
		await seed(fs);
		expect(code(await fs.readTextLines('/d', undefined, CTX))).toBe('is_directory');
		expect(code(await fs.readTextLines('/d', { maxLines: 2 }, CTX))).toBe('is_directory');
	});

	it('fileInfo / openBinaryReader 路径**穿过文件**报 not_directory（不是 not_found）', async () => {
		const fs = make();
		await seed(fs);
		expect(code(await fs.fileInfo('/f/child', CTX))).toBe('not_directory');
		expect(code(await fs.openBinaryReader('/f/child', undefined, CTX))).toBe('not_directory');
	});

	it('写操作**穿过文件**时报错，不建出「文件下挂子节点」的脏状态', async () => {
		const fs = make();
		await seed(fs);
		// 上游 writeFile/appendFile 报 unknown（ENOTDIR 未入 toFileError），createDir/remove 报 not_directory。
		// spec §3 要求可归类失败不落 unknown → 本仓统一落 not_directory。
		expect(code(await fs.writeFile('/f/child', 'y', CTX))).toBe('not_directory');
		expect(code(await fs.appendFile('/f/child', 'y', CTX))).toBe('not_directory');
		expect(code(await fs.createDir('/f/child', undefined, CTX))).toBe('not_directory');
		expect(code(await fs.remove('/f/child', undefined, CTX))).toBe('not_directory');
		// 关键：`/f` 仍是那个文件，内容没变，也没多出 `/f/child` 节点
		expect(fail(await fs.fileInfo('/f', CTX)).kind).toBe('file');
		expect(fail(await fs.readTextFile('/f', CTX))).toBe('x');
		expect(code(await fs.fileInfo('/f/child', CTX))).toBe('not_directory');
	});

	it('canonicalPath 要求路径存在（上游 realpath 报 ENOENT）', async () => {
		const fs = make();
		await seed(fs);
		expect(code(await fs.canonicalPath('/f', CTX))).toBe('ok');
		expect(code(await fs.canonicalPath('/nope', CTX))).toBe('not_found');
	});
});

describe('与上游 NodeExecutionEnv 的错误码逐条对照', () => {
	// 已登记的有意分叉：上游 `openTextLineReader(目录)` 返回 **ok**（POSIX 允许只读打开目录，
	// 错误拖到 `readLine` 才报 EISDIR——上游的延迟报错）。本仓在 open 时就落 `is_directory`：
	// 同一个失败，但更早、更可归类。不纳入逐条对照。
	it('同一组类型冲突在两边的可归类码一致（openTextLineReader 除外）', async () => {
		const env = new NodeExecutionEnv({ cwd: '/tmp' });
		const root = fail(await env.createTempDir('tc-cmp-', CTX));
		await env.createDir(`${root}/d`, undefined, CTX);
		await env.writeFile(`${root}/f`, 'x', CTX);

		const upstream = [
			code(await env.readTextFile(`${root}/d`, CTX)),
			code(await env.readBinaryFile(`${root}/d`, CTX)),
			code(await env.truncateFile(`${root}/d`, 1, CTX)),
			code(await env.flushFile(`${root}/d`, CTX)),
			code(await env.appendFile(`${root}/d`, 'x', CTX)),
			code(await env.writeFile(`${root}/d`, 'x', CTX)),
			code(await env.renameFile(`${root}/f`, `${root}/d`, CTX)),
			code(await env.createDir(`${root}/a/b`, { recursive: false }, CTX)),
		];

		const fs = createMemoryFileSystem('/');
		await seed(fs);
		const ours = [
			code(await fs.readTextFile('/d', CTX)),
			code(await fs.readBinaryFile('/d', CTX)),
			code(await fs.truncateFile('/d', 1, CTX)),
			code(await fs.flushFile('/d', CTX)),
			code(await fs.appendFile('/d', 'x', CTX)),
			code(await fs.writeFile('/d', 'x', CTX)),
			code(await fs.renameFile('/f', '/d', CTX)),
			code(await fs.createDir('/a/b', { recursive: false }, CTX)),
		];

		expect(ours).toEqual(upstream);
		await env.cleanup(CTX);
	});

	it('有意分叉：openTextLineReader(目录) 上游 ok，本仓 is_directory', async () => {
		const env = new NodeExecutionEnv({ cwd: '/tmp' });
		const root = fail(await env.createTempDir('tc-otl-', CTX));
		await env.createDir(`${root}/d`, undefined, CTX);
		const up = await env.openTextLineReader(`${root}/d`, CTX);
		expect(code(up)).toBe('ok');
		// 上游的错误在 readLine 才出现
		if (up.ok) expect(code(await up.value.readLine(CTX))).toBe('is_directory');
		await env.cleanup(CTX);

		const fs = createMemoryFileSystem('/');
		await fs.createDir('/d', undefined, CTX);
		expect(code(await fs.openTextLineReader('/d', CTX))).toBe('is_directory');
	});
});
