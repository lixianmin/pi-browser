// Task 6：Grep（递归 + glob 过滤）/ Ls / Glob 契约测试。
// Grep 基线 = spice `packages/harness/test/agent-tools.test.ts` 的「Grep tool」块（regex/literal/ignoreCase/
// limit/no-match 断言语义保留；`file:line: text` 与 context 行 `file-line- text` 格式逐字保留），
// 偏离点（spec §3.3）：递归全目录 + `glob` 过滤（spice 是白名单非递归）。Ls/Glob 无 spice 基线，新写。
import { describe, it, expect, beforeEach } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { FileError } from '@earendil-works/pi-durable/env';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { extensionCtx } from './helpers/extension-context';
import type { BrowserFileSystem } from '../src/env/types';
import { createGrepTool, createGrepToolDefinition, grepToolSystemPromptContribution } from '../src/tools/grep-tool';
import * as upstreamGrep from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js';
import { findOps, grepOps, lsOps } from './helpers/tool-operations';
import { createLsTool, createLsToolDefinition, lsToolSystemPromptContribution } from '../src/tools/ls-tool';
import * as upstreamLs from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js';
import { createFindTool, createFindToolDefinition, findToolSystemPromptContribution, relativizeFindResultPath } from '../src/tools/find-tool';
import * as upstreamFind from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js';

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
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'digitalWrite' }));
		expect(out).toContain('sketch.ino:2: digitalWrite(2, HIGH);');
		expect(out).toContain('sketch.ino:3: digitalWrite(2, LOW);');
	});

	it('递归进子目录（偏离 spice：spice 只扫白名单且非递归）', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'deep' }));
		expect(out).toContain('src/nested/deep.ts:1: const deep = true;');
	});

	it('glob 过滤（相对被搜目录匹配）', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'const', glob: 'src/*.ts' }));
		expect(out).toBe('src/app.ts:1: const a = 1;\nsrc/app.ts:2: const b = 2;');
		expect(out).not.toContain('nested/deep.ts');   // src/nested/deep.ts 也含 const：证明 glob 确实在过滤
	});

	// glob 的基准是 **cwd**（rg 把 glob 原样交给 `rg --glob`，rg 对含 `/` 的 pattern 按「相对 rg 进程 cwd」
	// 匹配），不是搜索根——终审 p2-3-search 的实证。输出仍然是相对搜索根（上游 formatPath），两者不是一回事。
	it('glob 相对 **cwd** 匹配，输出相对搜索根（两者不是同一个基准）', async () => {
		const tool = createGrepTool('/', { fs });
		// cwd=/ → 相对 cwd 就是 src/nested/deep.ts
		expect(textOf(await tool.execute('id', { pattern: 'const', path: 'src', glob: 'src/nested/*.ts' })))
			.toBe('nested/deep.ts:1: const deep = true;');
		// 用搜索根相对的老写法（`nested/*.ts`）在 rg 下不匹配，本仓也不再匹配
		expect(textOf(await tool.execute('id', { pattern: 'const', path: 'src', glob: 'nested/*.ts' })))
			.toBe('No matches found');
	});

	// 终审 p2-3-search 的实证（rg 15.2.0 实测：--hidden --glob '*.ts' 返回 3 个文件）：
	// pattern 不含 `/` 时 rg 对 **basename** 匹配，任意深度都算；原来本仓对「相对搜索根」的路径匹配，
	// 所以 '*.ts' 只命中顶层 —— 静默漏结果。
	it('glob 不含 `/` → 对 basename 匹配（rg 实测语义，任意深度都算）', async () => {
		const dotFs = createMemoryFileSystem();
		await seed(dotFs, { 'a.ts': 'needle\n', 'src/a.ts': 'needle\n', 'src/.gen/b.ts': 'needle\n', 'src/.gen/b.js': 'needle\n' });
		const out = textOf(await createGrepTool('/', { fs: dotFs }).execute('id', { pattern: 'needle', glob: '*.ts' }));
		expect(out).toContain('a.ts:1: needle');
		expect(out).toContain('src/a.ts:1: needle');
		expect(out).toContain('src/.gen/b.ts:1: needle');
		expect(out).not.toContain('b.js');
	});

	// rg 带 --hidden：通配符吃点号（实测 `src/*/*.ts` 命中 `src/.gen/b.ts`），
	// picomatch 默认 `dot: false` 会把点目录挡掉 —— 与 rg 不一致。
	it('glob 通配符吃点号（rg 的 --hidden 语义）', async () => {
		const dotFs = createMemoryFileSystem();
		await seed(dotFs, { 'a.ts': 'needle\n', 'src/a.ts': 'needle\n', 'src/.gen/b.ts': 'needle\n' });
		const tool = createGrepTool('/', { fs: dotFs });
		expect(textOf(await tool.execute('id', { pattern: 'needle', glob: 'src/*/*.ts' }))).toContain('src/.gen/b.ts');
		expect(textOf(await tool.execute('id', { pattern: 'needle', glob: 'src/**/*.ts' }))).toContain('src/.gen/b.ts');
	});

	it('无 glob 时所有文件都搜（.md / .ino 同样命中）', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'Polarity' }));
		expect(out).toContain('docs/parts.md:2: ## Polarity');
	});

	it('path 指向单文件 → 只搜该文件（输出 basename，上游 formatPath）', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'const', path: 'src/app.ts' }));
		expect(out).toBe('app.ts:1: const a = 1;\napp.ts:2: const b = 2;');
	});

	// rg 实测（15.2.0）：`rg --glob '*.ts' needle notes.txt` **照样返回** notes.txt 的命中 ——
	// rg 不对显式给的文件参数套 glob。所以本仓单文件路径忽略 glob 与上游同款（此前记为「待确认」，
	// 2026-10-02 用真 rg 钉死）。
	it('单文件搜索忽略 glob（rg 实测：显式文件参数不过 --glob）', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', {
			pattern: 'const', path: 'src/app.ts', glob: '*.md',
		}));
		expect(out).toContain('app.ts:1: const a = 1;');
	});

	// 二进制（含 NUL）不吐文本行（rg 的判据）：上游只提示 binary file matches。
	// 本仓 readFile 返回解码后的文本、PNG 不会抛错 —— 不挡就会吐整屏乱码。
	it('二进制文件（含 NUL）被跳过，不吐乱码行', async () => {
		const binFs = createMemoryFileSystem();
		// 夹具必须**同时**含 NUL 与可匹配的文本：真实二进制里就有字符串（编译产物里的字面量）。
		// 只放 PNG 头 + 空洞的话，pattern 根本命中不了，断言就成了假绿。
		const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			...new TextEncoder().encode('needle'), 0x00, 0x00, 0xff, 0xfe]);
		expect((await binFs.writeFile('/a.png', bin, BACKGROUND_CONTEXT)).ok).toBe(true);
		expect((await binFs.writeFile('/b.txt', 'needle\n', BACKGROUND_CONTEXT)).ok).toBe(true);
		const out = textOf(await createGrepTool('/', { fs: binFs }).execute('id', { pattern: 'needle' }));
		expect(out).toBe('b.txt:1: needle');
	});

	// 零命中 + 有文件读不动 → 报真实的读失败（上游 rg 是 exit 2 + reject），不伪装成「没匹配」：
	// 否则模型以为模式不在文件里，然后反复换 pattern 重试。
	it('读不动且零命中时抛真实错误，而不是 No matches found', async () => {
		const ops = {
			readFile: async (): Promise<string> => { throw new FileError('permission_denied', 'EACCES: 读不动', '/secret.ts'); },
			access: async () => {},
			isDirectory: async () => false,
		};
		await expect(createGrepTool('/', { fs, operations: ops }).execute('id', { pattern: 'x', path: '/secret.ts' }))
			.rejects.toThrow(/读不动/);
	});

	// 有命中时读失败仍不打断（部分结果比全丢有用）
	it('有命中时读失败不打断整次搜索（部分结果照常返回）', async () => {
		const ops = {
			readFile: async (p: string): Promise<string> => {
				if (p.endsWith('locked.ts')) throw new FileError('permission_denied', 'EACCES', p);
				const r = await fs.readTextFile(p, BACKGROUND_CONTEXT);
				if (!r.ok) throw r.error;
				return r.value;
			},
			access: async (p: string) => { const r = await fs.fileInfo(p, BACKGROUND_CONTEXT); if (!r.ok) throw r.error; },
			isDirectory: async (p: string) => { const r = await fs.fileInfo(p, BACKGROUND_CONTEXT); return r.ok && r.value.kind === 'directory'; },
		};
		await seed(fs, { 'locked.ts': 'const hidden = 1;\n' });
		const out = textOf(await createGrepTool('/', { fs, operations: ops }).execute('id', { pattern: 'const' }));
		expect(out).toContain('src/app.ts:1:');
	});

	// 读不动（二进制等）的文件跳过：不能因此打断整次搜索。
	// 读不动的文件（原 `catch { continue }`，零覆盖）：不能因此打断整次搜索。
	it('读不动的文件被跳过，不打断整次搜索', async () => {
		const ops = {
			readFile: async (p: string): Promise<string> => {
				if (p.endsWith('binary.bin')) throw new Error('EACCES: 读不动');
				const r = await fs.readTextFile(p, BACKGROUND_CONTEXT);
				if (!r.ok) throw r.error;
				return r.value;
			},
			access: async (p: string) => { const r = await fs.fileInfo(p, BACKGROUND_CONTEXT); if (!r.ok) throw r.error; },
			isDirectory: async (p: string) => { const r = await fs.fileInfo(p, BACKGROUND_CONTEXT); return r.ok && r.value.kind === 'directory'; },
		};
		await seed(fs, { 'sub/binary.bin': 'x' });
		const out = textOf(await createGrepTool('/', { fs, operations: ops }).execute('id', { pattern: 'const' }));
		expect(out).toContain('src/app.ts:1:');
	});

	it('literal mode (literal: true) treats pattern as string', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'pinMode(2', literal: true }));
		expect(out).toContain('sketch.ino:1:');
	});

	it('ignoreCase', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'polarity', ignoreCase: true }));
		expect(out).toContain('parts.md');
	});

	it('context 行格式：命中行 `path:line:`，上下文行 `path-line-`（spice 格式）', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'digitalWrite\\(2, HIGH\\)', context: 1 }));
		expect(out).toBe([
			'sketch.ino-1- pinMode(2, OUTPUT);',
			'sketch.ino:2: digitalWrite(2, HIGH);',
			'sketch.ino-3- digitalWrite(2, LOW);',
		].join('\n'));
	});

	it('reports match limit（上游文案：limit reached + limit=2x 提示，无尾句号）', async () => {
		const r = await createGrepTool('/src', { fs }).execute('id', { pattern: 'const', limit: 1 });
		expect(textOf(r)).toMatch(/1 matches limit reached\. Use limit=2 for more, or refine pattern/);
		expect(r.details?.matchLimitReached).toBe(1);
	});

	it('returns no matches cleanly', async () => {
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'nonexistent_pattern_xyz' }));
		expect(out).toBe('No matches found');
	});

	it('超长行截断 → 行尾标记 + notice', async () => {
		await seed(fs, { 'long.txt': `head ${'x'.repeat(600)}\n` });
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'head' }));
		expect(out).toContain('... [truncated]');
		expect(out).toContain('[Some lines truncated to 500 chars. Use read tool to see full lines]');
	});

	it('非法正则 → invalid', async () => {
		const t = createGrepTool('/', { fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'a(' }))).toBe('invalid');
	});

	it('非法 glob → invalid', async () => {
		const t = createGrepTool('/', { fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'const', glob: '' }))).toBe('invalid');
	});

	it('path 不存在 → not_found', async () => {
		const t = createGrepTool('/', { fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'x', path: 'nope' }))).toBe('not_found');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createGrepTool('/', { fs });
		expect(await rejectionCode(t.execute('id', { pattern: 'const' }, AbortSignal.abort()))).toBe('aborted');
	});

	it('静态字段与上游产物逐字相等（P2c 契约）', () => {
		const up = upstreamGrep.createGrepToolDefinition('/tmp');
		const mine = createGrepToolDefinition('/tmp', { fs, operations: grepOps(fs) });
		expect(mine.name).toBe(up.name);
		expect(mine.label).toBe(up.label);
		expect(mine.description).toBe(up.description);
		expect(mine.promptSnippet).toBe(up.promptSnippet);
		expect(mine.promptGuidelines).toEqual(up.promptGuidelines);
		expect(JSON.parse(JSON.stringify(mine.parameters))).toEqual(JSON.parse(JSON.stringify(up.parameters)));
		expect(grepToolSystemPromptContribution).toEqual(upstreamGrep.grepToolSystemPromptContribution);
	});

	it('fs 缺省 → 构造期响亮报错（D5）', () => {
		expect(() => createGrepToolDefinition('/tmp')).toThrow(/fs/);
		expect(() => createGrepTool('/tmp')).toThrow(/fs/);
	});

	it('命中数恰好等于 limit → 仍报 limit reached（上游第 N 条就置位）', async () => {
		await seed(fs, { 'many.txt': `${Array.from({ length: 100 }, () => 'x').join('\n')}\n` });
		const r = await createGrepTool('/', { fs }).execute('id', { pattern: '^x$', limit: 100 });
		expect(textOf(r)).toContain('[100 matches limit reached. Use limit=200 for more, or refine pattern]');
		expect(r.details?.matchLimitReached).toBe(100);
	});

	it('CR-only 行尾当行分隔符（不是当字符删掉）', async () => {
		await seed(fs, { 'cr.txt': 'alpha\rbeta\r' });
		const out = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'alpha' }));
		expect(out).toBe('cr.txt:1: alpha');
	});

	it('字节截断 → 50.0KB notice + details.truncation', async () => {
		await seed(fs, { 'big.txt': Array.from({ length: 300 }, (_, i) => `needle ${i} ${'y'.repeat(400)}`).join('\n') });
		const r = await createGrepTool('/', { fs }).execute('id', { pattern: 'needle', limit: 1000 });
		expect(textOf(r)).toContain('50.0KB limit reached');
		expect(r.details?.truncation?.truncated).toBe(true);
	});

	it('注入 operations 与默认 operations 输出一致（双路）', async () => {
		const withDefault = textOf(await createGrepTool('/', { fs }).execute('id', { pattern: 'const' }));
		const withInjected = textOf(await createGrepTool('/', { fs, operations: grepOps(fs) }).execute('id', { pattern: 'const' }));
		expect(withInjected).toBe(withDefault);
	});

	it('ctx.cwd 覆盖构造期 cwd（定义件）', async () => {
		await seed(fs, { 'd/x.txt': 'needle' });
		const def = createGrepToolDefinition('/e', { fs });
		const ctx = extensionCtx('/d');
		expect(textOf(await def.execute('id', { pattern: 'needle' }, undefined, undefined, ctx))).toContain('x.txt:1: needle');
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
		const out = textOf(await createLsTool('/', { operations: lsOps(fs) }).execute('id', {}));
		expect(out).toBe(['empty/', 'readme.md', 'src/'].join('\n'));
	});

	it('path 指定目录 + cwd 基准（输出条目名，上游语义）', async () => {
		const out = textOf(await createLsTool('/src', { operations: lsOps(fs) }).execute('id', { path: 'nested' }));
		expect(out).toBe('c.ts');
	});

	it('空目录 → (empty directory)', async () => {
		const out = textOf(await createLsTool('/', { operations: lsOps(fs) }).execute('id', { path: 'empty' }));
		expect(out).toBe('(empty directory)');
	});

	it('path 是文件 → Not a directory', async () => {
		const t = createLsTool('/', { operations: lsOps(fs) });
		expect(await rejectionCode(t.execute('id', { path: 'readme.md' }))).toBe('not_directory');
	});

	it('path 不存在 → not_found', async () => {
		const t = createLsTool('/', { operations: lsOps(fs) });
		expect(await rejectionCode(t.execute('id', { path: 'nope' }))).toBe('not_found');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createLsTool('/', { operations: lsOps(fs) });
		expect(await rejectionCode(t.execute('id', {}, AbortSignal.abort()))).toBe('aborted');
	});

	it('limit + entryLimitReached notice（上游文案）', async () => {
		const r = await createLsTool('/', { operations: lsOps(fs) }).execute('id', { limit: 2 });
		expect(textOf(r)).toContain('[2 entries limit reached. Use limit=4 for more]');
		expect(r.details?.entryLimitReached).toBe(2);
	});

	it('stat 失败的条目被跳过（不占 limit）', async () => {
		const ops = {
			exists: async (): Promise<boolean> => true,
			stat: async (p: string): Promise<{ isDirectory(): boolean }> => {
				if (p === '/') return { isDirectory: () => true };
				if (p.endsWith('readme.md')) throw new Error('boom');
				return { isDirectory: () => p === '/src' };
			},
			readdir: async (): Promise<string[]> => ['readme.md', 'src'],
		};
		const out = textOf(await createLsTool('/', { operations: ops }).execute('id', {}));
		expect(out).toBe('src/');

		// 终审 p2-7：原来没传 limit（走 DEFAULT_LIMIT），「跳过的条目不消耗配额」这半个属性没被验证。
		// 传 limit=1：若跳过也占配额，readme.md 吃掉唯一名额，src 就该被 limit 截掉。
		const limited = textOf(await createLsTool('/', { operations: ops }).execute('id', { limit: 1 }));
		expect(limited).toContain('src/');
	});

	it('静态字段与上游产物逐字相等（P2c 契约）', () => {
		const up = upstreamLs.createLsToolDefinition('/tmp');
		const mine = createLsToolDefinition('/tmp', { operations: lsOps(fs) });
		expect(mine.name).toBe(up.name);
		expect(mine.label).toBe(up.label);
		expect(mine.description).toBe(up.description);
		expect(mine.promptSnippet).toBe(up.promptSnippet);
		expect(mine.promptGuidelines).toEqual(up.promptGuidelines);
		expect(JSON.parse(JSON.stringify(mine.parameters))).toEqual(JSON.parse(JSON.stringify(up.parameters)));
		expect(lsToolSystemPromptContribution).toEqual(upstreamLs.lsToolSystemPromptContribution);
	});

	it('operations 缺省 → 构造期响亮报错（D5）', () => {
		expect(() => createLsToolDefinition('/tmp')).toThrow(/operations/);
		expect(() => createLsTool('/tmp')).toThrow(/operations/);
	});

	it('ctx.cwd 覆盖构造期 cwd（定义件）', async () => {
		const def = createLsToolDefinition('/e', { operations: lsOps(fs) });
		const ctx = extensionCtx('/src');
		expect(textOf(await def.execute('id', {}, undefined, undefined, ctx))).toContain('a.ts');
	});
});

describe('find tool', () => {
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, { 'a.ts': '1\n', 'a.md': '1\n', 'ab.ts': '1\n', 'src/b.ts': '1\n', 'src/nested/c.ts': '1\n', 'src/readme.md': '1\n' });
	});

	it('**/*.ts 递归匹配（含根层文件）', async () => {
		const out = textOf(await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: '**/*.ts' }));
		expect(out).toBe(['a.ts', 'ab.ts', 'src/b.ts', 'src/nested/c.ts'].join('\n'));
	});

	it('* 不跨 /（只匹配根层）', async () => {
		const out = textOf(await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: '*.md' }));
		expect(out).toBe('a.md');
	});

	it('? 匹配单字符', async () => {
		const out = textOf(await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: 'a?.ts' }));
		expect(out).toBe('ab.ts');
	});

	it('path 选项：相对被搜目录匹配、输出也相对搜索根（上游语义）', async () => {
		const out = textOf(await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: '**/*.ts', path: 'src' }));
		expect(out).toBe(['b.ts', 'nested/c.ts'].join('\n'));
	});

	it('只返回文件（目录不入选）', async () => {
		const out = textOf(await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: '*' }));
		expect(out).toBe(['a.md', 'a.ts', 'ab.ts'].join('\n'));
	});

	it('无匹配 → No files found matching pattern', async () => {
		const out = textOf(await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: '**/*.py' }));
		expect(out).toBe('No files found matching pattern');
	});

	it('base 是文件 → not_directory', async () => {
		const t = createFindTool('/', { operations: findOps(fs) });
		expect(await rejectionCode(t.execute('id', { pattern: '*.ts', path: 'a.ts' }))).toBe('not_directory');
	});

	it('非法 pattern（空串）→ invalid', async () => {
		const t = createFindTool('/', { operations: findOps(fs) });
		expect(await rejectionCode(t.execute('id', { pattern: '' }))).toBe('invalid');
	});

	it('调用前已 abort → aborted', async () => {
		const t = createFindTool('/', { operations: findOps(fs) });
		expect(await rejectionCode(t.execute('id', { pattern: '*.ts' }, AbortSignal.abort()))).toBe('aborted');
	});

	it('limit + resultLimitReached notice（上游 custom-ops 文案）', async () => {
		const r = await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: '**/*.ts', limit: 2 });
		expect(textOf(r)).toContain('[2 results limit reached]');
		expect(r.details?.resultLimitReached).toBe(2);
	});

	it('把 ignore/limit 传给注入的 glob（上游 custom-ops 契约）', async () => {
		let captured: { ignore: string[]; limit: number } | undefined;
		const spy = {
			exists: async (): Promise<boolean> => true,
			glob: async (_pattern: string, _cwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> => { captured = options; return []; },
		};
		await createFindTool('/', { operations: spy }).execute('id', { pattern: '*.ts', limit: 7 });
		expect(captured).toEqual({ ignore: ['**/node_modules/**', '**/.git/**'], limit: 7 });
	});

	it('relativizeFindResultPath：搜索根之下相对化、保留尾斜杠、非绝对原样、根外补 ../', () => {
		expect(relativizeFindResultPath('/w/src/a.ts', '/w/src')).toBe('a.ts');
		expect(relativizeFindResultPath('/w/src/nested/', '/w/src')).toBe('nested/');
		expect(relativizeFindResultPath('rel/a.ts', '/w')).toBe('rel/a.ts');
		expect(relativizeFindResultPath('/w/a.ts', '/')).toBe('w/a.ts');   // 与 node path.relative('/', '/w/a.ts') 一致
		expect(relativizeFindResultPath('/other/a.ts', '/w/src')).toBe('../../other/a.ts');
	});

	it('静态字段与上游产物逐字相等（P2c 契约）', () => {
		const up = upstreamFind.createFindToolDefinition('/tmp');
		const mine = createFindToolDefinition('/tmp', { operations: findOps(fs) });
		expect(mine.name).toBe(up.name);
		expect(mine.label).toBe(up.label);
		expect(mine.description).toBe(up.description);
		expect(mine.promptSnippet).toBe(up.promptSnippet);
		expect(mine.promptGuidelines).toEqual(up.promptGuidelines);
		expect(JSON.parse(JSON.stringify(mine.parameters))).toEqual(JSON.parse(JSON.stringify(up.parameters)));
		expect(findToolSystemPromptContribution).toEqual(upstreamFind.findToolSystemPromptContribution);
	});

	it('operations 缺省 → 构造期响亮报错（D5）', () => {
		expect(() => createFindToolDefinition('/tmp')).toThrow(/operations/);
		expect(() => createFindTool('/tmp')).toThrow(/operations/);
	});

	it('ctx.cwd 覆盖构造期 cwd（定义件）', async () => {
		const def = createFindToolDefinition('/e', { operations: findOps(fs) });
		const ctx = extensionCtx('/src');
		expect(textOf(await def.execute('id', { pattern: '**/*.ts' }, undefined, undefined, ctx))).toContain('b.ts');
	});
});
