// Task 5：Read/Write/Edit 工具契约测试（fs 背书）。
// 平移源 = spice `packages/harness/test/agent-tools.test.ts` 的 Read/Write/Edit 三块，断言语义保留，
// 数据装配从「registry 注册资源」改为「BrowserFileSystem 写文件」；
// 数据源差异（registry→fs）带来的用例改写：未注册路径 → not_found；read-only 路径白名单 → 删除
// （那是 spice 域的 docs/ 规则，通用 fs 无此概念）；新增 spec §3.3 要求的「多命中并列位置」。
import { describe, it, expect, beforeEach } from 'vitest';
import { BACKGROUND_CONTEXT, err, FileError, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import { createReadTool } from '../src/tools/read-tool';
import { createWriteTool } from '../src/tools/write-tool';
import { createEditTool } from '../src/tools/edit-tool';
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
		const t = createReadTool({ fs });
		expect(textOf(await t.execute('id', { path: 'sketch.ino' }))).toBe('a\nb\nc\nd\ne');
	});

	it('truncates with continuation hint when over 50KB', async () => {
		const big = 'x'.repeat(DEFAULT_MAX_BYTES + 100);
		await seed(fs, { 'big.txt': big });
		const out = textOf(await createReadTool({ fs }).execute('id', { path: 'big.txt' }));
		expect(out).toMatch(/Use offset=\d+ to continue\./);
		expect(out.length).toBeLessThanOrEqual(big.length);
	});

	it('行截断的 continuation 文案逐字保留（LLM 依赖该语义）', async () => {
		await seed(fs, { 'many.txt': Array.from({ length: 2100 }, () => 'x').join('\n') });
		const out = textOf(await createReadTool({ fs }).execute('id', { path: 'many.txt' }));
		expect(out.endsWith('[Showing lines 1-2000 of 2100 (50.0KB limit). Use offset=2001 to continue.]')).toBe(true);
	});

	it('offset/limit paginates', async () => {
		const out = textOf(await createReadTool({ fs }).execute('id', { path: 'sketch.ino', offset: 2, limit: 2 }));
		expect(out).toContain('b\nc');
		expect(out).toMatch(/2 more lines\. Use offset=4 to continue\./);
	});

	it('offset 超出文件末尾 → invalid（带总数）', async () => {
		const t = createReadTool({ fs });
		await expect(t.execute('id', { path: 'sketch.ino', offset: 99 })).rejects.toThrow(/beyond end of file \(5 lines total\)/);
		expect(await rejectionCode(t.execute('id', { path: 'sketch.ino', offset: 99 }))).toBe('invalid');
	});

	it('throws on missing file (not_found)', async () => {
		const t = createReadTool({ fs });
		await expect(t.execute('id', { path: 'nope.txt' })).rejects.toThrow(/not found/i);
		expect(await rejectionCode(t.execute('id', { path: 'nope.txt' }))).toBe('not_found');
	});

	it('cwd 选项决定相对路径基准', async () => {
		await seed(fs, { '/d/inner.txt': 'inner' });
		const t = createReadTool({ fs, cwd: '/d' });
		expect(textOf(await t.execute('id', { path: 'inner.txt' }))).toBe('inner');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createReadTool({ fs });
		expect(await rejectionCode(t.execute('id', { path: 'sketch.ino' }, AbortSignal.abort()))).toBe('aborted');
	});
});

describe('Write tool', () => {
	let fs: BrowserFileSystem;
	beforeEach(() => { fs = createMemoryFileSystem(); });

	it('成功文案逐字保留（spice e2e 依赖）', async () => {
		const out = textOf(await createWriteTool({ fs }).execute('id', { path: 'a.txt', content: 'hello' }));
		expect(out).toBe('Successfully wrote to a.txt (5 bytes).');
		expect(await readBack(fs, '/a.txt')).toBe('hello');
	});

	it('覆盖已存在文件', async () => {
		await seed(fs, { 'a.txt': 'old' });
		await createWriteTool({ fs }).execute('id', { path: 'a.txt', content: 'new' });
		expect(await readBack(fs, '/a.txt')).toBe('new');
	});

	it('偏离 spice：自动建父目录（BrowserFileSystem.writeFile 语义）', async () => {
		const t = createWriteTool({ fs });
		await t.execute('id', { path: 'deep/nested/a.txt', content: 'x' });
		expect(await readBack(fs, '/deep/nested/a.txt')).toBe('x');
	});

	it('fs 报错 → 原样抛出（不吞、不重写 code）', async () => {
		const base = createMemoryFileSystem();
		const failing: BrowserFileSystem = {
			...base,
			writeFile: async () => err(new FileError('permission_denied', `permission denied: /a.txt`, '/a.txt')),
		};
		await expect(createWriteTool({ fs: failing }).execute('id', { path: 'a.txt', content: 'x' }))
			.rejects.toMatchObject({ code: 'permission_denied', path: '/a.txt' });
	});

	it('调用前已 abort → aborted（且不落盘）', async () => {
		const t = createWriteTool({ fs });
		expect(await rejectionCode(t.execute('id', { path: 'a.txt', content: 'x' }, AbortSignal.abort()))).toBe('aborted');
		const exists = await fs.exists('/a.txt', CTX);
		expect(exists.ok && exists.value).toBe(false);
	});
});

describe('Edit tool', () => {
	const SKETCH = 'void setup() {\n  pinMode(2, OUTPUT);\n}\nvoid loop() {\n  digitalWrite(2, HIGH);\n}\n';
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, { 'sketch.ino': SKETCH });
	});

	it('single edit replaces text', async () => {
		const r = await createEditTool({ fs }).execute('id', { path: 'sketch.ino', edits: [{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(5, OUTPUT);' }] });
		expect(textOf(r)).toMatch(/replaced 1 block/);
		expect(await readBack(fs, '/sketch.ino')).toContain('pinMode(5, OUTPUT);');
		expect(await readBack(fs, '/sketch.ino')).not.toContain('pinMode(2, OUTPUT);');
	});

	it('multi-edits in one call（按原文件匹配，不增量）', async () => {
		await createEditTool({ fs }).execute('id', { path: 'sketch.ino', edits: [
			{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(2, INPUT);' },
			{ oldText: 'digitalWrite(2, HIGH);', newText: 'digitalWrite(2, LOW);' },
		] });
		const content = await readBack(fs, '/sketch.ino');
		expect(content).toContain('pinMode(2, INPUT);');
		expect(content).toContain('digitalWrite(2, LOW);');
	});

	it('fuzzy match for smart quotes', async () => {
		await seed(fs, { 'q.ino': 'const x = \u201csmart\u201d;' });
		await createEditTool({ fs }).execute('id', { path: 'q.ino', edits: [{ oldText: '\u201csmart\u201d', newText: 'curly' }] });
		expect(await readBack(fs, '/q.ino')).toContain('curly');
	});

	it('成功出 diff + patch（details）', async () => {
		const r = await createEditTool({ fs }).execute('id', { path: 'sketch.ino', edits: [{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(5, OUTPUT);' }] });
		expect(r.details.diff).toContain('-2   pinMode(2, OUTPUT);');
		expect(r.details.diff).toContain('+2   pinMode(5, OUTPUT);');
		expect(r.details.firstChangedLine).toBe(2);
		expect(r.details.patch).toContain('--- sketch.ino');
	});

	it('多命中 → 报错并列每处行号（spec §3.3）', async () => {
		await seed(fs, { 'dup.txt': 'x = 1;\ny = 2;\nx = 1;\nz = 3;\nx = 1;\n' });
		const t = createEditTool({ fs });
		await expect(t.execute('id', { path: 'dup.txt', edits: [{ oldText: 'x = 1;', newText: 'x = 9;' }] }))
			.rejects.toThrow(/Found 3 occurrences of edits\[x = 1;\] \(lines 1, 3, 5\)\. The text must be unique in the file\./);
		expect(await rejectionCode(t.execute('id', { path: 'dup.txt', edits: [{ oldText: 'x = 1;', newText: 'y' }] }))).toBe('invalid');
	});

	it('无命中 → not_found', async () => {
		const t = createEditTool({ fs });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [{ oldText: 'nope', newText: 'x' }] })).rejects.toThrow(/Could not find/);
		expect(await rejectionCode(t.execute('id', { path: 'sketch.ino', edits: [{ oldText: 'nope', newText: 'x' }] }))).toBe('not_found');
	});

	it('rejects overlapping edits', async () => {
		const t = createEditTool({ fs });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [
			{ oldText: 'pinMode(2, OUTPUT);', newText: 'x' },
			{ oldText: 'OUTPUT);\n}', newText: 'y' },
		] })).rejects.toThrow(/overlap/);
	});

	it('rejects empty oldText', async () => {
		const t = createEditTool({ fs });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [{ oldText: '', newText: 'x' }] })).rejects.toThrow(/empty/);
	});

	it('edits 为空数组 → invalid', async () => {
		const t = createEditTool({ fs });
		await expect(t.execute('id', { path: 'sketch.ino', edits: [] })).rejects.toThrow(/at least one entry/);
	});

	it('无变化（newText === oldText）→ 报错，不写盘', async () => {
		await expect(createEditTool({ fs }).execute('id', { path: 'sketch.ino', edits: [{ oldText: 'pinMode(2, OUTPUT);', newText: 'pinMode(2, OUTPUT);' }] }))
			.rejects.toThrow(/identical/);
		expect(await readBack(fs, '/sketch.ino')).toBe(SKETCH);
	});

	it('CRLF 文件编辑后行尾保留 CRLF', async () => {
		await seed(fs, { 'crlf.txt': 'a\r\nb\r\n' });
		await createEditTool({ fs }).execute('id', { path: 'crlf.txt', edits: [{ oldText: 'b', newText: 'B' }] });
		expect(await readBack(fs, '/crlf.txt')).toBe('a\r\nB\r\n');
	});

	it('文件不存在 → not_found', async () => {
		const t = createEditTool({ fs });
		expect(await rejectionCode(t.execute('id', { path: 'nope.txt', edits: [{ oldText: 'a', newText: 'b' }] }))).toBe('not_found');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createEditTool({ fs });
		expect(await rejectionCode(t.execute('id', { path: 'sketch.ino', edits: [{ oldText: 'a', newText: 'b' }] }, AbortSignal.abort()))).toBe('aborted');
	});
});
