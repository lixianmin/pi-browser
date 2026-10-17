// @vitest-environment node
// abort 语义对照（vs 上游 `NodeExecutionEnv`）。
//
// 上游 `pi-durable/env/node` 对 18 个 FileSystem 方法做**入口** abort 检查
// （`abortResult(context.abortSignal)` → `err(new FileError('aborted', ...))`）：
// readTextFile / readBinaryFile / openBinaryReader / writeFile / appendFile / truncateFile / flushFile /
// renameFile / fileInfo / listDir / openDirReader / canonicalPath / exists / createDir / remove /
// createTempDir / openTextLineReader / watch；外加 BinaryReader 的 info/read/scanLines、DirReader.next、
// TextLineReader.readLine。
//
// 不查的：absolutePath / joinPath（纯路径计算）、readTextLines（外层；内部 readLine 会查）、
// createTempFile、cleanup、以及三种 reader 的 close（清理不该被取消）。
//
// 为什么这不是"可选的优化"：cancel 的价值在**已取消的调用不产生副作用**。writeFile 在取消后仍写盘、
// remove 在取消后仍删文件，都是可观察的错误行为。spec §11 原裁决「context 只接不用」基于
// 「浏览器后端无异步 IO 可中断」——那个前提只对"中断进行中的操作"成立（lightning-fs 的 IndexedDB
// 请求确实没有 cancel 面），但入口检查是另一回事，成本一行、语义必要。本文件钉住入口检查。
import './helpers/idb';
import { describe, it, expect } from 'vitest';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT, withAbortSignal } from '../src/env/context';
import type { BrowserFileSystem } from '../src/env/types';
import { createBrowserFileSystem } from '../src/env/backend-idb';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const CTX = BACKGROUND_CONTEXT;
const abortedCtx = () => { const ac = new AbortController(); ac.abort(); return withAbortSignal(ac.signal, CTX); };
const fail = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
	if (!r.ok) throw new Error(`expected ok: ${r.error.code}`);
	return r.value;
};
const code = (r: { ok: true; value: unknown } | { ok: false; error: { code: string } }) => (r.ok ? 'ok' : r.error.code);

/** 同一套断言跑两个浏览器后端：契约是共享的，实现是两份。 */
const backends: [string, () => BrowserFileSystem][] = [
	['memory', () => createMemoryFileSystem('/')],
	['idb', () => createBrowserFileSystem({ dbName: `abort-${Math.random().toString(36).slice(2)}`, memory: false })],
];

describe.each(backends)('abort 入口检查：%s 后端', (_name, make) => {
	it('writeFile 在已取消的 context 下返 aborted，且**不产生副作用**', async () => {
		const fs = make();
		const r = await fs.writeFile('/should-not-exist.txt', 'x', abortedCtx());
		expect(code(r)).toBe('aborted');
		expect(fail(await fs.exists('/should-not-exist.txt', CTX))).toBe(false);
	});

	it('readTextFile / readBinaryFile 返 aborted', async () => {
		const fs = make();
		await fs.writeFile('/a.txt', 'hello', CTX);
		expect(code(await fs.readTextFile('/a.txt', abortedCtx()))).toBe('aborted');
		expect(code(await fs.readBinaryFile('/a.txt', abortedCtx()))).toBe('aborted');
	});

	it('remove 在已取消的 context 下返 aborted，且**文件仍在**', async () => {
		const fs = make();
		await fs.writeFile('/keep.txt', 'x', CTX);
		expect(code(await fs.remove('/keep.txt', undefined, abortedCtx()))).toBe('aborted');
		expect(fail(await fs.exists('/keep.txt', CTX))).toBe(true);
	});

	it('其余写/查方法返 aborted', async () => {
		const fs = make();
		await fs.writeFile('/b.txt', 'abc', CTX);
		expect(code(await fs.appendFile('/b.txt', 'd', abortedCtx()))).toBe('aborted');
		expect(code(await fs.truncateFile('/b.txt', 1, abortedCtx()))).toBe('aborted');
		expect(code(await fs.flushFile('/b.txt', abortedCtx()))).toBe('aborted');
		expect(code(await fs.renameFile('/b.txt', '/c.txt', abortedCtx()))).toBe('aborted');
		expect(code(await fs.fileInfo('/b.txt', abortedCtx()))).toBe('aborted');
		expect(code(await fs.listDir('/', abortedCtx()))).toBe('aborted');
		expect(code(await fs.exists('/b.txt', abortedCtx()))).toBe('aborted');
		expect(code(await fs.createDir('/nd', undefined, abortedCtx()))).toBe('aborted');
		expect(code(await fs.createTempDir('x-', abortedCtx()))).toBe('aborted');
		expect(code(await fs.canonicalPath('/b.txt', abortedCtx()))).toBe('aborted');
	});

	it('openTextLineReader / openBinaryReader / openDirReader 返 aborted', async () => {
		const fs = make();
		await fs.writeFile('/r.txt', 'x', CTX);
		await fs.createDir('/rd', undefined, CTX);
		expect(code(await fs.openTextLineReader('/r.txt', abortedCtx()))).toBe('aborted');
		expect(code(await fs.openBinaryReader('/r.txt', undefined, abortedCtx()))).toBe('aborted');
		expect(code(await fs.openDirReader('/rd', abortedCtx()))).toBe('aborted');
	});

	it('BinaryReader.info / read / scanLines 返 aborted', async () => {
		const fs = make();
		await fs.writeFile('/br.txt', 'hello', CTX);
		const reader = fail(await fs.openBinaryReader('/br.txt', undefined, CTX));
		expect(code(await reader.info(abortedCtx()))).toBe('aborted');
		expect(code(await reader.read(0, 2, abortedCtx()))).toBe('aborted');
		expect(code(await reader.scanLines({ startLine: 0 }, abortedCtx()))).toBe('aborted');
	});

	it('DirReader.next 返 aborted', async () => {
		const fs = make();
		await fs.createDir('/dd', undefined, CTX);
		const reader = fail(await fs.openDirReader('/dd', CTX));
		expect(code(await reader.next(1, abortedCtx()))).toBe('aborted');
	});

	it('TextLineReader.readLine 返 aborted', async () => {
		const fs = make();
		await fs.writeFile('/tl.txt', 'x', CTX);
		const reader = fail(await fs.openTextLineReader('/tl.txt', CTX));
		expect(code(await reader.readLine(abortedCtx()))).toBe('aborted');
	});

	it('与上游一致地**不**查 abort 的方法：absolutePath / joinPath / cleanup / close', async () => {
		const fs = make();
		await fs.writeFile('/tl2.txt', 'x', CTX);
		// 纯路径计算：上游不查
		expect(code(await fs.absolutePath('a', abortedCtx()))).toBe('ok');
		expect(code(await fs.joinPath(['a', 'b'], abortedCtx()))).toBe('ok');
		// cleanup 是清理，不该被取消
		await expect(fs.cleanup(abortedCtx())).resolves.toBeUndefined();
		// reader.close 是清理，不该被取消
		const reader = fail(await fs.openTextLineReader('/tl2.txt', CTX));
		await expect(reader.close(abortedCtx())).resolves.toBeUndefined();
	});
});

describe('与上游 NodeExecutionEnv 的 abort 行为逐条对齐', () => {
	it('同一组调用在两边的错误码一致', async () => {
		const env = new NodeExecutionEnv({ cwd: '/tmp' });
		const nodeRoot = fail(await env.createTempDir('abort-cmp-', CTX));
		await env.writeFile(`${nodeRoot}/f.txt`, 'hello', CTX);
		const fs = createMemoryFileSystem('/');

		const upstream: string[] = [
			code(await env.readTextFile(`${nodeRoot}/f.txt`, abortedCtx())),
			code(await env.writeFile(`${nodeRoot}/w.txt`, 'x', abortedCtx())),
			code(await env.remove(`${nodeRoot}/f.txt`, undefined, abortedCtx())),
			code(await env.openBinaryReader(`${nodeRoot}/f.txt`, undefined, abortedCtx())),
			code(await env.openTextLineReader(`${nodeRoot}/f.txt`, abortedCtx())),
			code(await env.openDirReader(nodeRoot, abortedCtx())),
			code(await env.absolutePath('a', abortedCtx())),
		];

		const ours: string[] = [
			code(await fs.readTextFile('/f.txt', abortedCtx())),
			code(await fs.writeFile('/w.txt', 'x', abortedCtx())),
			code(await fs.remove('/f.txt', undefined, abortedCtx())),
			code(await fs.openBinaryReader('/f.txt', undefined, abortedCtx())),
			code(await fs.openTextLineReader('/f.txt', abortedCtx())),
			code(await fs.openDirReader('/', abortedCtx())),
			code(await fs.absolutePath('a', abortedCtx())),
		];

		// 先各自铺好基线文件（上面的调用都在 aborted context 下，不该生效）
		await fs.writeFile('/f.txt', 'hello', CTX);
		expect(ours).toEqual(upstream);
		await env.cleanup(CTX);
	});
});
