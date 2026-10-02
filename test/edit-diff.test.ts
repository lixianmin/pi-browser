// Task 10（P2a-3）：edit-diff 逐字转写 pi-coding-agent@1.0.0 后的契约测试。
//
// 核心手段：直接 import 上游产物 `edit-diff.js` 做等价表，不手抄期望值
// （上游产物由 devDep `@earendil-works/pi-coding-agent` 提供，devDep 精确钉 1.0.0）。
// 本仓独有的偏离（fs 绑定的 computeEditsDiff 收注入式 operations）单独测。
import { describe, it, expect } from 'vitest';
import { access as fsAccess, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ours from '../src/tools/edit-diff';
import * as upstream from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js';

type EditInput = { oldText: string; newText: string };

/** 把「返回结果 or 抛错 message」压成同一形状，用于与上游比对（含错误文案逐字）。 */
const outcome = (
	apply: (content: string, edits: EditInput[], path: string) => unknown,
	content: string,
	edits: EditInput[],
): unknown => {
	try {
		return { ok: true, value: apply(content, edits, 'a.txt') };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
};

describe('edit-diff 与上游 1.0.0 同形', () => {
	it('运行时导出集合与上游 d.ts 的 11 个函数逐字相等', async () => {
		const dts = await readFile(
			new URL('../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.d.ts', import.meta.url),
			'utf8',
		);
		const upstreamFns = [...dts.matchAll(/^export declare function (\w+)/gm)].map((m) => m[1]).sort();
		const oursFns = Object.keys(await import('../src/tools/edit-diff')).sort();
		expect(upstreamFns).toHaveLength(11);   // 上游 d.ts 还有 5 个导出类型 + 一条 `export {};`，运行时只剩函数
		expect(oursFns).toEqual(upstreamFns);
	});

	it('detectLineEnding / normalizeToLF / restoreLineEndings / normalizeForFuzzyMatch 逐字一致', () => {
		const cases = ['a\r\nb\n', 'a\nb\r\n', 'no newline', '\u201chello\u201d  ', 'a\u00a0b  \nc', 'a\u2003b'];
		for (const c of cases) {
			expect(ours.detectLineEnding(c)).toBe(upstream.detectLineEnding(c));
			expect(ours.normalizeToLF(c)).toBe(upstream.normalizeToLF(c));
			expect(ours.normalizeForFuzzyMatch(c)).toBe(upstream.normalizeForFuzzyMatch(c));
			expect(ours.restoreLineEndings(c, '\r\n')).toBe(upstream.restoreLineEndings(c, '\r\n'));
		}
	});

	it('fuzzyFindText 逐字一致（含 fuzzy 归一下标与 contentForReplacement）', () => {
		const cases: Array<[string, string]> = [
			['hello world', 'world'],
			['const x = \u201csmart\u201d;', '\u201csmart\u201d'],
			['a  \nb', 'a'],
			['a\u00a0b', 'a b'],
			['abc', 'zzz'],
		];
		for (const [content, oldText] of cases) {
			expect(ours.fuzzyFindText(content, oldText)).toEqual(upstream.fuzzyFindText(content, oldText));
		}
	});

	it('applyEditsToNormalizedContent 的结果与抛错文案逐字一致', () => {
		const cases: Array<[string, EditInput[]]> = [
			['a\nb\nc\nd', [{ oldText: 'b', newText: 'B' }]],
			['a\nb\nc\nd\ne', [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }, { oldText: 'e', newText: 'E' }]],
			['abcdef', [{ oldText: 'abc', newText: 'X' }, { oldText: 'cde', newText: 'Y' }]],   // overlap
			['a', [{ oldText: '', newText: 'X' }]],                                          // empty oldText
			['a\nb', [{ oldText: 'a', newText: 'a' }]],                                      // no change
			['a', [{ oldText: 'X', newText: 'Y' }]],                                         // not found
			['a\nb\nb\nc', [{ oldText: 'b', newText: 'B' }]],                                 // duplicate
		];
		for (const [content, edits] of cases) {
			expect(outcome(ours.applyEditsToNormalizedContent, content, edits)).toEqual(
				outcome(upstream.applyEditsToNormalizedContent, content, edits),
			);
		}
	});

	it('applyReplacementsPreservingUnchangedLines 逐字一致（其余行保留原始字节）', () => {
		const original = 'a\u00a0b\nkeep me  \n';
		const base = 'a b\nkeep me\n';
		const replacements = [{ matchIndex: 0, matchLength: 3, newText: 'X' }];
		expect(ours.applyReplacementsPreservingUnchangedLines(original, base, replacements)).toBe('X\nkeep me  \n');
		expect(upstream.applyReplacementsPreservingUnchangedLines(original, base, replacements)).toBe('X\nkeep me  \n');
	});

	it('applyReplacementsPreservingUnchangedLines 行数不一致时抛错', () => {
		expect(() => ours.applyReplacementsPreservingUnchangedLines('a\n', 'a\nb\n', [])).toThrow(/different line count/);
	});

	it('generateDiffString / generateUnifiedPatch 逐字一致', () => {
		const long = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
		const cases: Array<[string, string]> = [
			['a\nb', 'a\nB'],
			[long, long.replace('l0', 'L0').replace('l19', 'L19')],
			['one\ntwo\nthree\nfour\nfive', 'one\n2\nthree\nfour\n5'],
		];
		for (const [oldContent, newContent] of cases) {
			expect(ours.generateDiffString(oldContent, newContent)).toEqual(upstream.generateDiffString(oldContent, newContent));
			expect(ours.generateUnifiedPatch('a.txt', oldContent, newContent)).toBe(upstream.generateUnifiedPatch('a.txt', oldContent, newContent));
		}
	});
});

describe('computeEditsDiff / computeEditDiff（D5：fs 访问收注入式 operations）', () => {
	it('与上游同结果（注入 node fs 作 operations）', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pi-edit-'));
		try {
			await writeFile(join(dir, 'a.txt'), 'a\nb\nc\n');
			const ops = {
				access: async (p: string): Promise<void> => { await fsAccess(p); },
				readFile: async (p: string): Promise<string> => await readFile(p, 'utf8'),
			};
			expect(await ours.computeEditsDiff('a.txt', [{ oldText: 'b', newText: 'B' }], dir, ops)).toEqual(
				await upstream.computeEditsDiff('a.txt', [{ oldText: 'b', newText: 'B' }], dir),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('access 失败 → { error }，带上游的 Error code 文案', async () => {
		const ops = {
			access: async (): Promise<void> => { throw Object.assign(new Error('boom'), { code: 'not_found' }); },
			readFile: async (): Promise<string> => '',
		};
		expect(await ours.computeEditsDiff('a.txt', [{ oldText: 'a', newText: 'b' }], '/w', ops)).toEqual({
			error: 'Could not edit file: a.txt. Error code: not_found.',
		});
	});

	it('readFile 失败 → { error }（原样 message）；编辑逻辑失败 → { error }（plain Error message）', async () => {
		const readFails = { access: async (): Promise<void> => {}, readFile: async (): Promise<string> => { throw new Error('boom'); } };
		expect(await ours.computeEditsDiff('a.txt', [{ oldText: 'a', newText: 'b' }], '/w', readFails)).toEqual({ error: 'boom' });

		const noMatch = { access: async (): Promise<void> => {}, readFile: async (): Promise<string> => 'a\n' };
		const r = (await ours.computeEditsDiff('a.txt', [{ oldText: 'zzz', newText: 'b' }], '/w', noMatch)) as { error: string };
		expect(r.error).toContain('Could not find');
	});

	it('computeEditDiff 是单编辑包装', async () => {
		const ops = { access: async (): Promise<void> => {}, readFile: async (): Promise<string> => 'a\n' };
		expect(await ours.computeEditDiff('a.txt', 'a', 'A', '/w', ops)).toEqual(
			await ours.computeEditsDiff('a.txt', [{ oldText: 'a', newText: 'A' }], '/w', ops),
		);
	});
});

// 以下 describe 从 test/tools-utils.test.ts 搬来（断言逐字保留）。
describe('Edit-diff utilities', () => {
	it('applyEditsToNormalizedContent preserves unchanged text', () => {
		const r = ours.applyEditsToNormalizedContent('a\nb\nc\nd', [{ oldText: 'b', newText: 'B' }], 'a.txt');
		expect(r.newContent).toBe('a\nB\nc\nd');
	});

	it('multi-edit: order-stable, no overlap', () => {
		const r = ours.applyEditsToNormalizedContent('a\nb\nc\nd\ne', [
			{ oldText: 'a', newText: 'A' },
			{ oldText: 'c', newText: 'C' },
			{ oldText: 'e', newText: 'E' },
		], 'a.txt');
		expect(r.newContent).toBe('A\nb\nC\nd\nE');
	});

	it('rejects overlap', () => {
		expect(() => ours.applyEditsToNormalizedContent('abcdef', [
			{ oldText: 'abc', newText: 'X' },
			{ oldText: 'cde', newText: 'Y' },
		], 'a.txt')).toThrow(/overlap/);
	});

	it('rejects empty oldText', () => {
		expect(() => ours.applyEditsToNormalizedContent('a', [{ oldText: '', newText: 'X' }], 'a.txt')).toThrow(/empty/);
	});

	it('rejects no-change', () => {
		expect(() => ours.applyEditsToNormalizedContent('a\nb', [{ oldText: 'a', newText: 'a' }], 'a.txt')).toThrow(/identical/);
	});

	it('throws on not-found', () => {
		expect(() => ours.applyEditsToNormalizedContent('a', [{ oldText: 'X', newText: 'Y' }], 'a.txt')).toThrow(/Could not find/);
	});

	it('fuzzy match: smart quotes normalized', () => {
		const r = ours.applyEditsToNormalizedContent('const x = "smart";', [{ oldText: '\u201csmart\u201d', newText: 'curly' }], 'a.txt');
		expect(r.newContent).toBe('const x = curly;');
	});

	it('P2 修：fuzzy 命中后 replace 不甩字（保留所有原始字符）', () => {
		const r = ours.applyEditsToNormalizedContent(
			'const greeting = \u201cHello, World!\u201d;\nconst x = 1;\n',
			[{ oldText: '\u201cHello, World!\u201d', newText: '\u201cHi\u201d' }],
			'a.txt',
		);
		expect(r.newContent).toBe('const greeting = \u201cHi\u201d;\nconst x = 1;\n');
		expect(r.newContent.split('\n')[1]).toBe('const x = 1;');
	});

	it('line endings: CRLF preserved on input + LF internally', () => {
		const r = ours.restoreLineEndings('a\nb\nc', '\r\n');
		expect(r).toBe('a\r\nb\r\nc');
	});

	it('detectLineEnding 认首个行尾（CRLF 优先于后续 LF）', () => {
		expect(ours.detectLineEnding('a\r\nb\n')).toBe('\r\n');
		expect(ours.detectLineEnding('a\nb\r\n')).toBe('\n');
		expect(ours.detectLineEnding('no newline')).toBe('\n');
	});

	it('normalizeToLF collapses CRLF + CR', () => {
		expect(ours.normalizeToLF('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
	});

	it('normalizeForFuzzyMatch: smart quotes → straight quotes', () => {
		expect(ours.normalizeForFuzzyMatch('\u201chello\u201d')).toBe('"hello"');
	});

	it('generateDiffString 带行号 + firstChangedLine', () => {
		const r = ours.generateDiffString('a\nb', 'a\nB');
		expect(r.diff).toBe(' 1 a\n-2 b\n+2 B');
		expect(r.firstChangedLine).toBe(2);
	});
});

describe('splitBom（P2a 从 edit-diff 移出，转写源上游 utils/text.js）', () => {
	it('splitBom strips leading BOM', async () => {
		const { splitBom } = await import('../src/tools/text');
		const r = splitBom('\ufeffhello');
		expect(r.bom).toBe('\ufeff');
		expect(r.text).toBe('hello');
	});
});
