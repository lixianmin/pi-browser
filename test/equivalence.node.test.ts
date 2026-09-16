// @vitest-environment node
// spec §3 测试 2：与 `NodeExecutionEnv` 的**策展等价表**（不是严格差分）。
//
// 为什么不能严格相等：两边的错误映射与路径语义有意不同（见文件末「已登记的有意分叉」）。这里只对
// **必须一致**的操作序列逐条对表：同一序列在真临时目录（NodeExecutionEnv）与 pi-browser 内存后端
// 上各跑一遍，把每步压成 `标签: ok <值>` / `标签: err <码>` 再整体比对——不一致时 diff 直接指出哪一步。
// 路径全用相对路径：Node 按 cwd（临时目录）解析，pi-browser 内存后端取 'cwd=/' 语义，两边各自落在自己的根里。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, type FileError, type FileSystem, type Result } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';   // 测试文件可用；src/** 禁（浏览器产物面）
import { createBrowserFileSystem } from '../src/index';

const CTX = BACKGROUND_CONTEXT;
const nodeRoot = mkdtempSync(join(tmpdir(), 'pi-browser-'));
afterAll(() => { rmSync(nodeRoot, { recursive: true, force: true }); });

const getOrFail = <T>(r: Result<T, FileError>): T => {
	if (!r.ok) throw new Error(`expected ok, got error: ${r.error.code} ${r.error.message}`);
	return r.value;
};

/** 把一步操作压成可比字符串；`show` 负责把 ok 值写成稳定文本（默认不显示值） */
async function record<T>(out: string[], label: string, r: Promise<Result<T, FileError>>, show: (v: T) => string = () => ''): Promise<void> {
	const res = await r;
	out.push(res.ok ? `${label}: ok ${show(res.value)}` : `${label}: err ${res.error.code}`);
}

/** 必须一致的操作序列（spec §3 测试 2 的清单） */
async function transcript(fs: FileSystem): Promise<string[]> {
	const out: string[] = [];
	await record(out, 'writeFile(notes/a.txt)', fs.writeFile('notes/a.txt', 'hello', CTX));
	await record(out, 'readTextFile(notes/a.txt)', fs.readTextFile('notes/a.txt', CTX), JSON.stringify);
	await record(out, 'appendFile(notes/a.txt, " world")', fs.appendFile('notes/a.txt', ' world', CTX));
	await record(out, 'readTextFile(notes/a.txt) 追加后', fs.readTextFile('notes/a.txt', CTX), JSON.stringify);
	await record(out, 'readTextLines(notes/a.txt, maxLines:1)', fs.readTextLines('notes/a.txt', { maxLines: 1 }, CTX), JSON.stringify);
	await record(out, 'writeFile(notes/b.txt, old)', fs.writeFile('notes/b.txt', 'old', CTX));
	await record(out, 'renameFile(notes/b.txt → notes/a.txt) 覆盖已存在目标', fs.renameFile('notes/b.txt', 'notes/a.txt', CTX));
	await record(out, 'readTextFile(notes/a.txt) rename 后', fs.readTextFile('notes/a.txt', CTX), JSON.stringify);
	await record(out, 'writeFile(bin.dat, [1,2,3])', fs.writeFile('bin.dat', new Uint8Array([1, 2, 3]), CTX));
	await record(out, 'readBinaryFile(bin.dat)', fs.readBinaryFile('bin.dat', CTX), (v) => [...v].join(','));
	await record(out, 'createDir(deep/x/y, recursive:true)', fs.createDir('deep/x/y', { recursive: true }, CTX));
	await record(out, 'fileInfo(deep/x/y)', fs.fileInfo('deep/x/y', CTX), (v) => `kind=${v.kind} name=${v.name}`);
	// 非递归删非空目录：两边都报错，但**码不比**——Node 的 rm 报 ERR_FS_EISDIR，toFileError 无此分支→ unknown；
	// pi-browser 落 is_directory（spec §3 错误映射要求可归类失败不落 unknown，把 Node 的 unknown 对齐过来是明确禁止的）。
	const rm = await fs.remove('deep', undefined, CTX);
	out.push(`remove(deep) 非递归删非空目录: ${rm.ok ? 'ok' : 'err'}`);
	await record(out, 'readTextFile(missing.txt)', fs.readTextFile('missing.txt', CTX));
	await record(out, 'fileInfo(notes/a.txt)', fs.fileInfo('notes/a.txt', CTX), (v) => `kind=${v.kind} name=${v.name} size=${v.size}`);
	await record(out, 'exists(not-here.txt)', fs.exists('not-here.txt', CTX), String);
	return out;
}

describe('策展等价表：必须一致的操作序列', () => {
	it('pi-browser 内存后端 与 NodeExecutionEnv 逐条相等', async () => {
		const browser = createBrowserFileSystem({ memory: true });
		const node = new NodeExecutionEnv({ cwd: nodeRoot });
		expect(await transcript(browser)).toEqual(await transcript(node));
		await browser.cleanup(CTX);
		await node.cleanup(CTX);
	});
});

// 登记接受的有意分叉（spec §3 测试 2）。**不比对 Node**，只钉住 pi-browser 侧行为，注释说明为何接受。
describe('已登记的有意分叉', () => {
	it('canonicalPath 不解析符号链接（Node 用 realpath）', async () => {
		// 接受：两个浏览器后端都没有符号链接（lightning-fs 无 symlink，内存后端只存 kind file|directory），
		// 归一即规范路径。Node 的 canonicalPath 走 realpath，会解析 symlink；对齐它需要先有 symlink 支持。
		const browser = createBrowserFileSystem({ memory: true });
		expect(getOrFail(await browser.canonicalPath('a/../b', CTX))).toBe('/b');
	});

	it('listDir 内存后端排序（Node 用 readdir 原序）', async () => {
		// 接受：pi 契约不规定 listDir 顺序；内存后端固定升序（同输入同输出，便于上层断言），
		// Node readdir 顺序由文件系统决定。
		const browser = createBrowserFileSystem({ memory: true });
		await browser.writeFile('/z.txt', 'z', CTX);
		await browser.writeFile('/a.txt', 'a', CTX);
		expect(getOrFail(await browser.listDir('/', CTX)).map((i) => i.name)).toEqual(['a.txt', 'z.txt']);
	});

	it('exists 穿过文件返 ok(false)（Node 返 not_directory）', async () => {
		// 接受：Node lstat('/f.txt/child') 报 ENOTDIR → exists 返回 err(not_directory)；pi 契约只要求
		// 「缺失返 false」，穿透路径对浏览器后端一律视为不存在（两后端同一语义，路径穿过文件即不存在）。
		const browser = createBrowserFileSystem({ memory: true });
		await browser.writeFile('/f.txt', 'x', CTX);
		expect(getOrFail(await browser.exists('/f.txt/child', CTX))).toBe(false);
	});

	it('createDir 已存在 → invalid（Node 落 unknown）', async () => {
		// 接受：Node 的 toFileError 没有 EEXIST 分支 → unknown；spec §3 错误映射禁止可归类失败落 unknown。
		const browser = createBrowserFileSystem({ memory: true });
		expect((await browser.createDir('/d', { recursive: false }, CTX)).ok).toBe(true);
		const again = await browser.createDir('/d', { recursive: false }, CTX);
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error.code).toBe('invalid');
	});
});
