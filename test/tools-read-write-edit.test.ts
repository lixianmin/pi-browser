// Task 5：Read/Write/Edit 工具契约测试（fs 背书）。
// 平移源 = spice `packages/harness/test/agent-tools.test.ts` 的 Read/Write/Edit 三块，断言语义保留，
// 数据装配从「registry 注册资源」改为「BrowserFileSystem 写文件」；
// 数据源差异（registry→fs）带来的用例改写：未注册路径 → not_found；read-only 路径白名单 → 删除
// （那是 spice 域的 docs/ 规则，通用 fs 无此概念）；新增 spec §3.3 要求的「多命中并列位置」。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { err, FileError } from '@earendil-works/pi-durable/env';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import { createReadTool, createReadToolDefinition } from '../src/tools/read-tool';
import * as upstreamRead from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js';
import { extensionCtx } from './helpers/extension-context';
import { detectSupportedImageMimeType } from '../src/tools/image-mime';
import { editOps, readOps, writeOps } from './helpers/tool-operations';
import { createWriteTool, createWriteToolDefinition } from '../src/tools/write-tool';
import * as upstreamWrite from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js';
import { createEditTool, createEditToolDefinition } from '../src/tools/edit-tool';
import * as upstreamEdit from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js';
import { DEFAULT_MAX_BYTES } from '../src/tools/truncate';

const CTX = BACKGROUND_CONTEXT;

/** 工具结果 content 是 pi 的块数组（[{type:'text',text}]）→ 取文本 */
const textOf = (r: AgentToolResult<unknown>): string =>
	r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

const seed = async (fs: BrowserFileSystem, files: Record<string, string>): Promise<void> => {
	for (const [path, content] of Object.entries(files)) {
		const written = await fs.writeFile(path, content, CTX);
		if (!written.ok) throw written.error;
	}
};

const readBack = async (fs: BrowserFileSystem, path: string): Promise<string> => {
	const r = await fs.readTextFile(path, CTX);
	if (!r.ok) throw r.error;
	return r.value;
};

/** 工具失败抛的是 FileError（带 FileErrorCode）；这里取 code 做断言 */
const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
	try {
		await promise;
	} catch (e) {
		expect(e).toBeInstanceOf(FileError);
		return (e as FileError).code;
	}
	throw new Error('expected the tool call to reject');
};

describe('Read tool', () => {
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, { 'sketch.ino': 'a\nb\nc\nd\ne' });
	});

	it('reads whole small file', async () => {
		const t = createReadTool('/', { operations: readOps(fs) });
		expect(textOf(await t.execute('id', { path: 'sketch.ino' }))).toBe('a\nb\nc\nd\ne');
	});

	it('单行超 50KB → 给 bash fallback 提示（上游 firstLineExceedsLimit 分支）', async () => {
		const big = 'x'.repeat(DEFAULT_MAX_BYTES + 100);
		await seed(fs, { 'big.txt': big });
		const out = textOf(await createReadTool('/', { operations: readOps(fs) }).execute('id', { path: 'big.txt' }));
		expect(out).toMatch(/exceeds 50\.0KB limit\. Use bash: sed -n '1p' big\.txt \| head -c 51200\]/);
	});

	it('行截断的 continuation 文案逐字保留（LLM 依赖该语义）', async () => {
		await seed(fs, { 'many.txt': Array.from({ length: 2100 }, () => 'x').join('\n') });
		const out = textOf(await createReadTool('/', { operations: readOps(fs) }).execute('id', { path: 'many.txt' }));
		expect(out.endsWith('[Showing lines 1-2000 of 2100. Use offset=2001 to continue.]')).toBe(true);
	});

	it('offset/limit paginates', async () => {
		const out = textOf(await createReadTool('/', { operations: readOps(fs) }).execute('id', { path: 'sketch.ino', offset: 2, limit: 2 }));
		expect(out).toContain('b\nc');
		expect(out).toMatch(/2 more lines in file\. Use offset=4 to continue\./);
	});

	it('offset 超出文件末尾 → invalid（带总数）', async () => {
		const t = createReadTool('/', { operations: readOps(fs) });
		await expect(t.execute('id', { path: 'sketch.ino', offset: 99 })).rejects.toThrow(/beyond end of file \(5 lines total\)/);
		expect(await rejectionCode(t.execute('id', { path: 'sketch.ino', offset: 99 }))).toBe('invalid');
	});

	it('throws on missing file (not_found)', async () => {
		const t = createReadTool('/', { operations: readOps(fs) });
		await expect(t.execute('id', { path: 'nope.txt' })).rejects.toThrow(/not found/i);
		expect(await rejectionCode(t.execute('id', { path: 'nope.txt' }))).toBe('not_found');
	});

	it('cwd 选项决定相对路径基准', async () => {
		await seed(fs, { '/d/inner.txt': 'inner' });
		const t = createReadTool('/d', { operations: readOps(fs) });
		expect(textOf(await t.execute('id', { path: 'inner.txt' }))).toBe('inner');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createReadTool('/', { operations: readOps(fs) });
		expect(await rejectionCode(t.execute('id', { path: 'sketch.ino' }, AbortSignal.abort()))).toBe('aborted');
	});

	it('字节截断的 continuation 文案带尺寸后缀（与行截断分支区分）', async () => {
		await seed(fs, { 'wide.txt': Array.from({ length: 3000 }, () => 'x'.repeat(50)).join('\n') });
		const out = textOf(await createReadTool('/', { operations: readOps(fs) }).execute('id', { path: 'wide.txt' }));
		expect(out).toMatch(/\[Showing lines 1-\d+ of 3000 \(50\.0KB limit\)\. Use offset=\d+ to continue\.\]$/);
	});

	it('静态字段与上游产物逐字相等（P2b 契约）', () => {
		const up = upstreamRead.createReadToolDefinition('/tmp');
		const mine = createReadToolDefinition('/tmp', { operations: readOps(fs) });
		expect(mine.name).toBe(up.name);
		expect(mine.label).toBe(up.label);
		expect(mine.description).toBe(up.description);
		expect(mine.promptSnippet).toBe(up.promptSnippet);
		expect(mine.promptGuidelines).toEqual(up.promptGuidelines);
		expect(JSON.parse(JSON.stringify(mine.parameters))).toEqual(JSON.parse(JSON.stringify(up.parameters)));
	});

	it('operations 缺省 → 构造期响亮报错（D5）', () => {
		expect(() => createReadToolDefinition('/tmp')).toThrow(/operations/);
		expect(() => createReadTool('/tmp')).toThrow(/operations/);
	});

	it('定义件读 ctx.cwd，工厂件只认构造期 cwd', async () => {
		await seed(fs, { '/d/inner.txt': 'inner', '/e/inner.txt': 'other' });
		const def = createReadToolDefinition('/e', { operations: readOps(fs) });
		const ctx = extensionCtx('/d');
		expect(textOf(await def.execute('id', { path: 'inner.txt' }, undefined, undefined, ctx))).toBe('inner');
		expect(textOf(await createReadTool('/e', { operations: readOps(fs) }).execute('id', { path: 'inner.txt' }))).toBe('other');
	});

	// 终审 p2-2-rwe 的 Important：上游 read.js 的 execute 是 promise + abort 监听器包住整个执行体，
	// abort 事件一到就 reject；只靠 `throwIfAborted` 检查点的话，注入的慢 I/O（IDB / 远端）挂起期间
	// 取消不生效，必须等那次 I/O 返回。
	// 关键：abort 必须发生在**已经挂进 readFile 之后**——否则会被路径解析后的那个检查点兜住，这条用例变假绿。
	it('挂在 I/O 上时取消，立刻 reject（不等 I/O 落地）', async () => {
		await seed(fs, { '/e/slow.txt': 'x' });
		let enteredRead = (): void => {};
		let releaseRead = (): void => {};
		const readEntered = new Promise<void>((resolve) => { enteredRead = resolve; });
		const slowRead = new Promise<Uint8Array>((resolve) => { releaseRead = () => resolve(new TextEncoder().encode('late')); });
		const def = createReadToolDefinition('/e', {
			operations: { ...readOps(fs), readFile: () => { enteredRead(); return slowRead; } },
		});
		const ac = new AbortController();
		const pending = (def.execute as never as (...a: unknown[]) => Promise<unknown>)(
			'c1', { path: 'slow.txt' }, ac.signal, undefined, undefined,
		);
		await readEntered;                       // 现在它确定挂在 readFile 上
		ac.abort();
		const raced = await Promise.race([
			pending.then(() => 'RESOLVED', (e: unknown) => `REJECTED:${(e as Error).message}`),
			new Promise<string>((resolve) => setTimeout(() => resolve('HANG'), 50)),
		]);
		releaseRead();
		expect(raced).toMatch(/^REJECTED:.*aborted/i);
	});

	// `abortable` 的**成功路径**此前零覆盖（其它用例要么 signal=undefined 直接绕过、要么中途 abort），
	// 而那正是生产主路径：core 传一个不会 abort 的 signal、读成功。顺带钉住「结算后移除 abort 监听器」
	// ——漏了就是每次调用泄漏一个监听器。
	it('信号不 abort 时正常返回，且结算后移除 abort 监听器（生产主路径）', async () => {
		await seed(fs, { '/e/ok.txt': 'fine' });
		const def = createReadToolDefinition('/e', { operations: readOps(fs) });
		const ac = new AbortController();
		const add = vi.spyOn(ac.signal, 'addEventListener');
		const remove = vi.spyOn(ac.signal, 'removeEventListener');
		const r = await (def.execute as never as (...a: unknown[]) => Promise<AgentToolResult<unknown>>)(
			'c1', { path: 'ok.txt' }, ac.signal, undefined, undefined,
		);
		expect(textOf(r)).toBe('fine');
		expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	// 工厂件（createReadTool）此前**没有** abort 监听器：上游的工厂是
	// `wrapToolDefinition(createReadToolDefinition(...))`，天然继承定义件那份；本仓两个工厂各写一份
	// execute，工厂件漏包 → 大多数消费者走的路上「挂在 I/O 上取消」不生效。
	it('工厂件同样在挂在 I/O 上时立刻 reject（两个工厂都要包 abortable）', async () => {
		let enteredRead = (): void => {};
		let releaseRead = (): void => {};
		const readEntered = new Promise<void>((resolve) => { enteredRead = resolve; });
		const slowRead = new Promise<Uint8Array>((resolve) => { releaseRead = () => resolve(new TextEncoder().encode('late')); });
		await seed(fs, { '/e/slow.txt': 'x' });
		const tool = createReadTool('/e', { operations: { ...readOps(fs), readFile: () => { enteredRead(); return slowRead; } } });
		const ac = new AbortController();
		const pending = (tool.execute as never as (...a: unknown[]) => Promise<unknown>)('c1', { path: 'slow.txt' }, ac.signal, undefined);
		await readEntered;
		ac.abort();
		const raced = await Promise.race([
			pending.then(() => 'RESOLVED', (e: unknown) => `REJECTED:${(e as Error).message}`),
			new Promise<string>((resolve) => setTimeout(() => resolve('HANG'), 50)),
		]);
		releaseRead();
		expect(raced).toMatch(/^REJECTED:.*aborted/i);
	});

	// 工厂件的图片分支此前零覆盖（所有图片用例都走定义件）。
	it('工厂件读图：正常投递 image 块', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0]);
		await fs.writeFile('/e/a.png', png, CTX);
		const r = await createReadTool('/e', { operations: readOps(fs) }).execute('c1', { path: 'a.png' });
		expect(textOf(r)).toBe('Read image file [image/png]');
		expect(r.content.some((c) => c.type === 'image')).toBe(true);
	});

	// 终审 p2-2-rwe 的 Important：getNonVisionImageNote 与 processImage 无关（只拼一行文案），
	// 裁掉 processImage（D6/R1）时被连带动掉了。模型不支持图片却收到 image 块 = 静默丢内容。
	it('模型不支持 image 时，图片结果带上上游那句说明（不静默丢图）', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0]);
		await fs.writeFile('/e/a.png', png, CTX);
		const def = createReadToolDefinition('/e', { operations: readOps(fs) });
		const textOnly = { model: { input: ['text'] } } as never;
		const result = await (def.execute as never as (...a: unknown[]) => Promise<AgentToolResult<unknown>>)(
			'c1', { path: 'a.png' }, undefined, undefined, textOnly,
		);
		expect(textOf(result)).toContain('[Current model does not support images. The image will be omitted from this request.]');
		expect(result.content.some((c) => c.type === 'image')).toBe(true);

		const vision = { model: { input: ['text', 'image'] } } as never;
		const visionResult = await (def.execute as never as (...a: unknown[]) => Promise<AgentToolResult<unknown>>)(
			'c1', { path: 'a.png' }, undefined, undefined, vision,
		);
		expect(textOf(visionResult)).not.toContain('does not support images');
	});

	// 终审 p2-2-rwe：上游对「已在限内」的图是 no-op（image-resize-core.js:49 原样返回），所以偏差只在
	// 超限图上——上游 resize 缩不到限内就返回 ok:false，read 只回文本并说明（read.js:74-79）。我们没有
	// photon（D6/R1）做不了缩放，于是对齐「不把超限载荷塞进工具结果」这个**可观测契约**，文案逐字用上游那句。
	it('超限图片按上游降级：只回文本说明，不塞超大 base64（阈值 4.5MB base64 = 上游常量）', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0]);
		const big = new Uint8Array(3.6 * 1024 * 1024);        // base64 后约 4.8MB > 4.5MB
		big.set(png, 0);
		const bigFs = createMemoryFileSystem();
		await bigFs.writeFile('/e/big.png', big, CTX);
		const def = createReadToolDefinition('/e', { operations: readOps(bigFs) });
		const result = await (def.execute as never as (...a: unknown[]) => Promise<AgentToolResult<unknown>>)(
			'c1', { path: 'big.png' }, undefined, undefined, extensionCtx('/e'),
		);
		expect(textOf(result)).toContain('[Image omitted: could not be resized below the inline image size limit.]');
		expect(result.content.some((c) => c.type === 'image')).toBe(false);
	});

	it('限内图片不受影响（上游对限内图是 no-op：原样投递）', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0]);
		await fs.writeFile('/e/small.png', png, CTX);
		const def = createReadToolDefinition('/e', { operations: readOps(fs) });
		const result = await (def.execute as never as (...a: unknown[]) => Promise<AgentToolResult<unknown>>)(
			'c1', { path: 'small.png' }, undefined, undefined, extensionCtx('/e'),
		);
		expect(textOf(result)).toBe('Read image file [image/png]');
		expect(result.content.some((c) => c.type === 'image')).toBe(true);
	});

	it('ctx.cwd 为空串时回退构造期 cwd（与上游 `||` 同语义，不是 `??`）', async () => {
		await seed(fs, { '/e/x.txt': 'e' });
		const def = createReadToolDefinition('/e', { operations: readOps(fs) });
		const ctx = extensionCtx('');
		expect(textOf(await def.execute('id', { path: 'x.txt' }, undefined, undefined, ctx))).toBe('e');
	});

	it('图片魔数嗅探：PNG/JPEG/GIF/WEBP/BMP 认，文本与动画 PNG 不认', () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0]);
		expect(detectSupportedImageMimeType(png)).toBe('image/png');
		expect(detectSupportedImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(detectSupportedImageMimeType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
		expect(detectSupportedImageMimeType(new TextEncoder().encode('RIFFxxxxWEBP'))).toBe('image/webp');
		expect(detectSupportedImageMimeType(new TextEncoder().encode('hello'))).toBeNull();
		// JPEG-LS（0xf7）不是上游支持的 JPEG 变体
		expect(detectSupportedImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xf7]))).toBeNull();
		// BMP：DIB 头 40 字节、1 个色平面、24 bpp
		const bmp = new Uint8Array(30);
		bmp[0] = 0x42;   // 'B'
		bmp[1] = 0x4d;   // 'M'
		bmp.set([54, 0, 0, 0], 10);   // pixelDataOffset（>= 14 + 40）
		bmp.set([40, 0, 0, 0], 14);   // dibHeaderSize
		bmp.set([1, 0], 26);          // colorPlanes
		bmp.set([24, 0], 28);         // bitsPerPixel
		expect(detectSupportedImageMimeType(bmp)).toBe('image/bmp');
		// 动画 PNG：合法 IHDR 后跟 acTL 块 → 不当静态图片
		const animated = new Uint8Array(45);
		animated.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
		animated.set([0x61, 0x63, 0x54, 0x4c], 37);   // 'acTL'，chunk 长度 0（offset 33 的四个字节保持 0）
		expect(detectSupportedImageMimeType(animated)).toBeNull();
	});

	it('图片文件经 detectImageMimeType 命中 → 返回 text + image 块（D6）', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0]);
		const imgFs = createMemoryFileSystem();
		const written = await imgFs.writeFile('/pic.png', png, CTX);
		if (!written.ok) throw written.error;
		const def = createReadToolDefinition('/', { operations: readOps(imgFs) });
		const ctx = extensionCtx('/');
		const r = await def.execute('id', { path: 'pic.png' }, undefined, undefined, ctx);
		expect(r.content[0]).toEqual({ type: 'text', text: 'Read image file [image/png]' });
		expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
		// 不缩放（D6）：data 是原字节的 base64
		expect((r.content[1] as { data: string }).data).toBe(Buffer.from(png).toString('base64'));
		expect(r.details).toBeUndefined();
	});
});

describe('Write tool', () => {
	let fs: BrowserFileSystem;
	beforeEach(() => { fs = createMemoryFileSystem(); });

	it('成功文案逐字保留（spice e2e 依赖）', async () => {
		const out = textOf(await createWriteTool('/', { operations: writeOps(fs) }).execute('id', { path: 'a.txt', content: 'hello' }));
		expect(out).toBe('Successfully wrote to a.txt');
		expect(await readBack(fs, '/a.txt')).toBe('hello');
	});

	it('覆盖已存在文件', async () => {
		await seed(fs, { 'a.txt': 'old' });
		await createWriteTool('/', { operations: writeOps(fs) }).execute('id', { path: 'a.txt', content: 'new' });
		expect(await readBack(fs, '/a.txt')).toBe('new');
	});

	it('偏离 spice：自动建父目录（BrowserFileSystem.writeFile 语义）', async () => {
		const t = createWriteTool('/', { operations: writeOps(fs) });
		await t.execute('id', { path: 'deep/nested/a.txt', content: 'x' });
		expect(await readBack(fs, '/deep/nested/a.txt')).toBe('x');
	});

	it('fs 报错 → 原样抛出（不吞、不重写 code）', async () => {
		const base = createMemoryFileSystem();
		const failing: BrowserFileSystem = {
			...base,
			writeFile: async () => err(new FileError('permission_denied', `permission denied: /a.txt`, '/a.txt')),
		};
		await expect(createWriteTool('/', { operations: writeOps(failing) }).execute('id', { path: 'a.txt', content: 'x' }))
			.rejects.toMatchObject({ code: 'permission_denied', path: '/a.txt' });
	});

	it('调用前已 abort → aborted（且不落盘）', async () => {
		const t = createWriteTool('/', { operations: writeOps(fs) });
		expect(await rejectionCode(t.execute('id', { path: 'a.txt', content: 'x' }, AbortSignal.abort()))).toBe('aborted');
		const exists = await fs.exists('/a.txt', CTX);
		expect(exists.ok && exists.value).toBe(false);
	});

	it('静态字段与上游产物逐字相等（P2b 契约）', () => {
		const up = upstreamWrite.createWriteToolDefinition('/tmp');
		const mine = createWriteToolDefinition('/tmp', { operations: writeOps(fs) });
		expect(mine.name).toBe(up.name);
		expect(mine.label).toBe(up.label);
		expect(mine.description).toBe(up.description);
		expect(mine.promptSnippet).toBe(up.promptSnippet);
		expect(mine.promptGuidelines).toEqual(up.promptGuidelines);
		expect(JSON.parse(JSON.stringify(mine.parameters))).toEqual(JSON.parse(JSON.stringify(up.parameters)));
	});

	it('operations 缺省 → 构造期响亮报错（D5）', () => {
		expect(() => createWriteToolDefinition('/tmp')).toThrow(/operations/);
		expect(() => createWriteTool('/tmp')).toThrow(/operations/);
	});

	it('定义件读 ctx.cwd，工厂件只认构造期 cwd', async () => {
		const def = createWriteToolDefinition('/e', { operations: writeOps(fs) });
		const ctx = extensionCtx('/d');
		await def.execute('id', { path: 'x.txt', content: 'def' }, undefined, undefined, ctx);
		await createWriteTool('/e', { operations: writeOps(fs) }).execute('id', { path: 'x.txt', content: 'factory' });
		expect(await readBack(fs, '/d/x.txt')).toBe('def');
		expect(await readBack(fs, '/e/x.txt')).toBe('factory');
	});
});

describe('Edit tool', () => {
	// 注意（2026-10-02 裁决）：edit-diff 逐字转写上游 1.0.0 后，匹配/替换类失败抛 plain `Error`
	//（上游文案）；只有 fs 类失败经 fs-ops 仍是带 FileErrorCode 的 `FileError`。
	const SKETCH = 'void setup() {\n  pinMode(2, OUTPUT);\n}\nvoid loop() {\n  digitalWrite(2, HIGH);\n}\n';
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, { 'sketch.ino': SKETCH });
	});

	it('single edit replaces text', async () => {
		const r = await createEditTool('/', { operations: editOps(fs) }).execute('id', { path: 'sketch.ino', edits: [{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(5, OUTPUT);' }] });
		expect(textOf(r)).toMatch(/replaced 1 block/);
		expect(await readBack(fs, '/sketch.ino')).toContain('pinMode(5, OUTPUT);');
		expect(await readBack(fs, '/sketch.ino')).not.toContain('pinMode(2, OUTPUT);');
	});

	it('multi-edits in one call（按原文件匹配，不增量）', async () => {
		await createEditTool('/', { operations: editOps(fs) }).execute('id', { path: 'sketch.ino', edits: [
			{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(2, INPUT);' },
			{ oldText: 'digitalWrite(2, HIGH);', newText: 'digitalWrite(2, LOW);' },
		] });
		const content = await readBack(fs, '/sketch.ino');
		expect(content).toContain('pinMode(2, INPUT);');
		expect(content).toContain('digitalWrite(2, LOW);');
	});

	it('fuzzy match for smart quotes', async () => {
		await seed(fs, { 'q.ino': 'const x = \u201csmart\u201d;' });
		await createEditTool('/', { operations: editOps(fs) }).execute('id', { path: 'q.ino', edits: [{ oldText: '\u201csmart\u201d', newText: 'curly' }] });
		expect(await readBack(fs, '/q.ino')).toContain('curly');
	});

	it('成功出 diff + patch（details）', async () => {
		const r = await createEditTool('/', { operations: editOps(fs) }).execute('id', { path: 'sketch.ino', edits: [{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(5, OUTPUT);' }] });
		expect(r.details.diff).toContain('-2   pinMode(2, OUTPUT);');
		expect(r.details.diff).toContain('+2   pinMode(5, OUTPUT);');
		expect(r.details.firstChangedLine).toBe(2);
		expect(r.details.patch).toContain('--- sketch.ino');
		expect(r.details.patch).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m);   // 真 unified patch 的 hunk 头（jsdiff createTwoFilesPatch）
	});

	it('多命中 → 报错（上游 1.0.0 文案，plain Error）', async () => {
		await seed(fs, { 'dup.txt': 'x = 1;\ny = 2;\nx = 1;\nz = 3;\nx = 1;\n' });
		const t = createEditTool('/', { operations: editOps(fs) });
		await expect(t.execute('id', { path: 'dup.txt', edits: [{ oldText: 'x = 1;', newText: 'x = 9;' }] }))
			.rejects.toThrow(/Found 3 occurrences of the text in dup\.txt\. The text must be unique/);
	});

	it('无命中 → 报错（上游文案，plain Error）', async () => {
		const t = createEditTool('/', { operations: editOps(fs) });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [{ oldText: 'nope', newText: 'x' }] }))
			.rejects.toThrow(/Could not find the exact text in sketch\.ino/);
	});

	it('rejects overlapping edits', async () => {
		const t = createEditTool('/', { operations: editOps(fs) });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [
			{ oldText: 'pinMode(2, OUTPUT);', newText: 'x' },
			{ oldText: 'OUTPUT);\n}', newText: 'y' },
		] })).rejects.toThrow(/overlap/);
	});

	it('rejects empty oldText', async () => {
		const t = createEditTool('/', { operations: editOps(fs) });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [{ oldText: '', newText: 'x' }] })).rejects.toThrow(/empty/);
	});

	it('edits 为空数组 → invalid（上游文案）', async () => {
		const t = createEditTool('/', { operations: editOps(fs) });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [] })).rejects.toThrow(/at least one replacement/);
	});

	it('无变化（newText === oldText）→ 报错，不写盘', async () => {
		await expect(createEditTool('/', { operations: editOps(fs) }).execute('id', { path: 'sketch.ino', edits: [{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(2, OUTPUT);' }] }))
			.rejects.toThrow(/identical/);
		expect(await readBack(fs, '/sketch.ino')).toBe(SKETCH);
	});

	it('CRLF 文件编辑后行尾保留 CRLF', async () => {
		await seed(fs, { 'crlf.txt': 'a\r\nb\r\n' });
		await createEditTool('/', { operations: editOps(fs) }).execute('id', { path: 'crlf.txt', edits: [{ oldText: 'b', newText: 'B' }] });
		expect(await readBack(fs, '/crlf.txt')).toBe('a\r\nB\r\n');
	});

	it('文件不存在 → not_found', async () => {
		const t = createEditTool('/', { operations: editOps(fs) });
		expect(await rejectionCode(t.execute('id', { path: 'nope.txt', edits: [{ oldText: 'a', newText: 'b' }] }))).toBe('not_found');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createEditTool('/', { operations: editOps(fs) });
		expect(await rejectionCode(t.execute('id', { path: 'sketch.ino', edits: [{ oldText: 'a', newText: 'b' }] }, AbortSignal.abort()))).toBe('aborted');
	});

	it('静态字段与上游产物逐字相等（P2b 契约）', () => {
		const up = upstreamEdit.createEditToolDefinition('/tmp');
		const mine = createEditToolDefinition('/tmp', { operations: editOps(fs) });
		expect(mine.name).toBe(up.name);
		expect(mine.label).toBe(up.label);
		expect(mine.description).toBe(up.description);
		expect(mine.promptSnippet).toBe(up.promptSnippet);
		expect(mine.promptGuidelines).toEqual(up.promptGuidelines);
		expect(JSON.parse(JSON.stringify(mine.parameters))).toEqual(JSON.parse(JSON.stringify(up.parameters)));
	});

	it('operations 缺省 → 构造期响亮报错（D5）', () => {
		expect(() => createEditToolDefinition('/tmp')).toThrow(/operations/);
		expect(() => createEditTool('/tmp')).toThrow(/operations/);
	});

	it('定义件读 ctx.cwd，工厂件只认构造期 cwd', async () => {
		await seed(fs, { '/d/x.txt': 'a\nb', '/e/x.txt': 'a\nb' });
		const def = createEditToolDefinition('/e', { operations: editOps(fs) });
		const ctx = extensionCtx('/d');
		await def.execute('id', { path: 'x.txt', edits: [{ oldText: 'a', newText: 'A' }] }, undefined, undefined, ctx);
		await createEditTool('/e', { operations: editOps(fs) }).execute('id', { path: 'x.txt', edits: [{ oldText: 'a', newText: 'A' }] });
		expect(await readBack(fs, '/d/x.txt')).toBe('A\nb');
		expect(await readBack(fs, '/e/x.txt')).toBe('A\nb');
	});
});
