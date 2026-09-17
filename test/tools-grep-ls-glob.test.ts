// Task 6：Grep（递归 + include）/ Ls / Glob 契约测试。
// Grep 基线 = spice `packages/harness/test/agent-tools.test.ts` 的「Grep tool」块（regex/literal/ignoreCase/
// limit/no-match 断言语义保留；`file:line: text` 与 context 行 `file-line- text` 格式逐字保留），
// 偏离点（spec §3.3）：递归全目录 + `include` glob 过滤（spice 是白名单非递归）。Ls/Glob 无 spice 基线，新写。
import { describe, it, expect, beforeEach } from 'vitest';
import { BACKGROUND_CONTEXT, FileError, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import { createGrepTool } from '../src/tools/grep-tool';
import { createLsTool } from '../src/tools/ls-tool';
import { createGlobTool } from '../src/tools/glob-tool';

const CTX = BACKGROUND_CONTEXT;

const textOf = (r: AgentToolResult<unknown>): string =>
	r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

const seed = async (fs: BrowserFileSystem, files: Record<string, string>): Promise<void> => {
	for (const [path, content] of Object.entries(files)) {
		const written = await fs.writeFile(path, content, CTX);
		if (!written.ok) throw written.error;
	}
};

const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
	try {
		await promise;
	} catch (e) {
		expect(e).toBeInstanceOf(FileError);
		return (e as FileError).code;
	}
	throw new Error('expected the tool call to reject');
};

const WORKSPACE: Record<string, string> = {
	'sketch.ino': 'pinMode(2, OUTPUT);\ndigitalWrite(2, HIGH);\ndigitalWrite(2, LOW);\n',
	'docs/parts.md': '# LED\n## Polarity\nforward only\n',
	'src/app.ts': 'const a = 1;\nconst b = 2;\n',
	'src/util.ts': 'export function helper() {}\n',
	'src/nested/deep.ts': 'const deep = true;\n',
};

describe('Grep tool', () => {
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, WORKSPACE);
	});

	it('递归全目录，输出 file:line: text（spice 格式）', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'digitalWrite' }));
		expect(out).toContain('sketch.ino:2: digitalWrite(2, HIGH);');
		expect(out).toContain('sketch.ino:3: digitalWrite(2, LOW);');
	});

	it('递归进子目录（偏离 spice：spice 只扫白名单且非递归）', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'deep' }));
		expect(out).toContain('src/nested/deep.ts:1: const deep = true;');
	});

	it('include glob 过滤（相对被搜目录匹配）', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'const', include: 'src/*.ts' }));
		expect(out).toBe('src/app.ts:1: const a = 1;\nsrc/app.ts:2: const b = 2;');
		expect(out).not.toContain('nested/deep.ts');   // src/nested/deep.ts 也含 const：证明 include 确实在过滤
	});

	it('include 相对 `path` 指定的目录匹配', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'const', path: 'src', include: 'nested/*.ts' }));
		expect(out).toBe('src/nested/deep.ts:1: const deep = true;');
	});

	it('无 include 时所有文件都搜（.md / .ino 同样命中）', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'Polarity' }));
		expect(out).toContain('docs/parts.md:2: ## Polarity');
	});

	it('path 指向单文件 → 只搜该文件', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'const', path: 'src/app.ts' }));
		expect(out).toBe('src/app.ts:1: const a = 1;\nsrc/app.ts:2: const b = 2;');
	});

	it('literal mode (literal: true) treats pattern as string', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'pinMode(2', literal: true }));
		expect(out).toContain('sketch.ino:1:');
	});

	it('ignoreCase', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'polarity', ignoreCase: true }));
		expect(out).toContain('parts.md');
	});

	it('context 行格式：命中行 `path:line:`，上下文行 `path-line-`（spice 格式）', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'digitalWrite\\(2, HIGH\\)', context: 1 }));
		expect(out).toBe([
			'sketch.ino-1- pinMode(2, OUTPUT);',
			'sketch.ino:2: digitalWrite(2, HIGH);',
			'sketch.ino-3- digitalWrite(2, LOW);',
		].join('\n'));
	});

	it('reports match limit（spice 文案：limit reached + limit=2x 提示）', async () => {
		const r = await createGrepTool({ fs, cwd: '/src' }).execute('id', { pattern: 'const', limit: 1 });
		expect(textOf(r)).toMatch(/1 matches limit reached\. Use limit=2 for more, or refine pattern\./);
		expect(r.details.matchLimitReached).toBe(1);
	});

	it('returns no matches cleanly', async () => {
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'nonexistent_pattern_xyz' }));
		expect(out).toBe('No matches found.');
	});

	it('超长行截断 → 行尾标记 + notice', async () => {
		await seed(fs, { 'long.txt': `head ${'x'.repeat(600)}\n` });
		const out = textOf(await createGrepTool({ fs }).execute('id', { pattern: 'head' }));
		expect(out).toContain('... [truncated]');
		expect(out).toContain('[Some lines truncated to 500 chars. Use Read to see full lines.]');
	});

	it('非法正则 → invalid', async () => {
		const t = createGrepTool({ fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'a(' }))).toBe('invalid');
	});

	it('非法 include glob → invalid', async () => {
		const t = createGrepTool({ fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'const', include: '' }))).toBe('invalid');
	});

	it('path 不存在 → not_found', async () => {
		const t = createGrepTool({ fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'x', path: 'nope' }))).toBe('not_found');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createGrepTool({ fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'const' }, AbortSignal.abort()))).toBe('aborted');
	});
});

describe('Ls tool', () => {
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, { 'readme.md': 'r\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/nested/c.ts': 'c\n', 'empty/.keep': '' });
		await fs.remove('/empty/.keep', undefined, CTX);
	});

	it('单层：目录带尾斜杠、按名排序', async () => {
		const out = textOf(await createLsTool({ fs }).execute('id', {}));
		expect(out).toBe(['empty/', 'readme.md', 'src/'].join('\n'));
	});

	it('recursive：深度优先全相对路径', async () => {
		const out = textOf(await createLsTool({ fs }).execute('id', { recursive: true }));
		expect(out).toBe(['empty/', 'readme.md', 'src/', 'src/a.ts', 'src/b.ts', 'src/nested/', 'src/nested/c.ts'].join('\n'));
	});

	it('path 指定目录 + cwd 基准', async () => {
		const out = textOf(await createLsTool({ fs, cwd: '/src' }).execute('id', { path: 'nested', recursive: true }));
		expect(out).toBe('nested/c.ts');
	});

	it('空目录 → (empty directory)', async () => {
		const out = textOf(await createLsTool({ fs }).execute('id', { path: 'empty' }));
		expect(out).toBe('(empty directory)');
	});

	it('path 是文件 → 返回该文件路径', async () => {
		const out = textOf(await createLsTool({ fs }).execute('id', { path: 'readme.md' }));
		expect(out).toBe('readme.md');
	});

	it('path 不存在 → not_found', async () => {
		const t = createLsTool({ fs });
		expect(await rejectionCode(t.execute('id', { path: 'nope' }))).toBe('not_found');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createLsTool({ fs });
		expect(await rejectionCode(t.execute('id', {}, AbortSignal.abort()))).toBe('aborted');
	});
});

describe('Glob tool', () => {
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, { 'a.ts': '1\n', 'a.md': '1\n', 'ab.ts': '1\n', 'src/b.ts': '1\n', 'src/nested/c.ts': '1\n', 'src/readme.md': '1\n' });
	});

	it('**/*.ts 递归匹配（含根层文件）', async () => {
		const out = textOf(await createGlobTool({ fs }).execute('id', { pattern: '**/*.ts' }));
		expect(out).toBe(['a.ts', 'ab.ts', 'src/b.ts', 'src/nested/c.ts'].join('\n'));
	});

	it('* 不跨 /（只匹配根层）', async () => {
		const out = textOf(await createGlobTool({ fs }).execute('id', { pattern: '*.md' }));
		expect(out).toBe('a.md');
	});

	it('? 匹配单字符', async () => {
		const out = textOf(await createGlobTool({ fs }).execute('id', { pattern: 'a?.ts' }));
		expect(out).toBe('ab.ts');
	});

	it('path 选项：相对被搜目录匹配、相对 cwd 输出', async () => {
		const out = textOf(await createGlobTool({ fs }).execute('id', { pattern: '**/*.ts', path: 'src' }));
		expect(out).toBe(['src/b.ts', 'src/nested/c.ts'].join('\n'));
	});

	it('只返回文件（目录不入选）', async () => {
		const out = textOf(await createGlobTool({ fs }).execute('id', { pattern: '*' }));
		expect(out).toBe(['a.md', 'a.ts', 'ab.ts'].join('\n'));
	});

	it('无匹配 → No files matched.', async () => {
		const out = textOf(await createGlobTool({ fs }).execute('id', { pattern: '**/*.py' }));
		expect(out).toBe('No files matched.');
	});

	it('base 是文件 → not_directory', async () => {
		const t = createGlobTool({ fs });
		expect(await rejectionCode(t.execute('id', { pattern: '*.ts', path: 'a.ts' }))).toBe('not_directory');
	});

	it('非法 pattern（空串）→ invalid', async () => {
		const t = createGlobTool({ fs });
		expect(await rejectionCode(t.execute('id', { pattern: '' }))).toBe('invalid');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createGlobTool({ fs });
		expect(await rejectionCode(t.execute('id', { pattern: '*.ts' }, AbortSignal.abort()))).toBe('aborted');
	});
});
