// Task 5 平移：spice `packages/harness/test/agent-tools.test.ts` 的
// 「Truncation utilities」/「Edit-diff utilities」/「Path utilities」三块，断言语义逐字保留
// （去除 spice 域条目：isReadOnlyPath 与 Resource 相关断言；resolveToCwd 的绝对/相对断言保留）。
import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from '../src/tools/truncate';
import {
	applyEditsToNormalizedContent, detectLineEnding, generateDiffString, normalizeForFuzzyMatch, normalizeToLF, restoreLineEndings, splitBom,
} from '../src/tools/edit-diff';
import { resolveToCwd } from '../src/tools/path-utils';

describe('Truncation utilities', () => {
	it('truncateHead returns as-is when under limits', () => {
		const r = truncateHead('a\nb\nc', { maxLines: 10, maxBytes: 1000 });
		expect(r.truncated).toBe(false);
		expect(r.content).toBe('a\nb\nc');
	});

	it('truncateHead truncates by lines', () => {
		const r = truncateHead(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), { maxLines: 10, maxBytes: 1e6 });
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe('lines');
		expect(r.content.split('\n').length).toBe(10);
	});

	it('truncateHead returns empty when first line exceeds byte limit', () => {
		const big = 'x'.repeat(2000);
		const r = truncateHead(big, { maxLines: 100, maxBytes: 100 });
		expect(r.truncated).toBe(true);
		expect(r.firstLineExceedsLimit).toBe(true);
		expect(r.content).toBe('');
	});

	it('truncateLine 只截超长行，且标记 ... [truncated]', () => {
		expect(truncateLine('short')).toEqual({ text: 'short', wasTruncated: false });
		const long = truncateLine('x'.repeat(600));
		expect(long.wasTruncated).toBe(true);
		expect(long.text.endsWith('... [truncated]')).toBe(true);
	});

	it('formatSize 三档（B/KB/MB）', () => {
		expect(formatSize(512)).toBe('512B');
		expect(formatSize(50 * 1024)).toBe('50.0KB');
		expect(formatSize(2 * 1024 * 1024)).toBe('2.0MB');
		expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
	});

	it('截断走 TextEncoder 字节计数（多字节字符不被行数阈值骗过）', () => {
		const r = truncateHead('中'.repeat(100), { maxBytes: 30 });
		expect(r.truncated).toBe(true);
		expect(r.firstLineExceedsLimit).toBe(true);   // 单行 300 字节 > 30 字节
	});
});

describe('Edit-diff utilities', () => {
	it('applyEditsToNormalizedContent preserves unchanged text', () => {
		const r = applyEditsToNormalizedContent('a\nb\nc\nd', [{ oldText: 'b', newText: 'B' }], 'a.txt');
		expect(r.newContent).toBe('a\nB\nc\nd');
	});

	it('multi-edit: order-stable, no overlap', () => {
		const r = applyEditsToNormalizedContent('a\nb\nc\nd\ne', [
			{ oldText: 'a', newText: 'A' },
			{ oldText: 'c', newText: 'C' },
			{ oldText: 'e', newText: 'E' },
		], 'a.txt');
		expect(r.newContent).toBe('A\nb\nC\nd\nE');
	});

	it('rejects overlap', () => {
		expect(() => applyEditsToNormalizedContent('abcdef', [
			{ oldText: 'abc', newText: 'X' },
			{ oldText: 'cde', newText: 'Y' },
		], 'a.txt')).toThrow(/overlap/);
	});

	it('rejects empty oldText', () => {
		expect(() => applyEditsToNormalizedContent('a', [{ oldText: '', newText: 'X' }], 'a.txt')).toThrow(/empty/);
	});

	it('rejects no-change', () => {
		expect(() => applyEditsToNormalizedContent('a\nb', [{ oldText: 'a', newText: 'a' }], 'a.txt')).toThrow(/identical/);
	});

	it('throws on not-found', () => {
		expect(() => applyEditsToNormalizedContent('a', [{ oldText: 'X', newText: 'Y' }], 'a.txt')).toThrow(/Could not find/);
	});

	it('fuzzy match: smart quotes normalized', () => {
		const r = applyEditsToNormalizedContent('const x = "smart";', [{ oldText: '\u201csmart\u201d', newText: 'curly' }], 'a.txt');
		expect(r.newContent).toBe('const x = curly;');
	});

	it('P2 修：fuzzy 命中后 replace 不甩字（保留所有原始字符）', () => {
		const r = applyEditsToNormalizedContent(
			'const greeting = \u201cHello, World!\u201d;\nconst x = 1;\n',
			[{ oldText: '\u201cHello, World!\u201d', newText: '\u201cHi\u201d' }],
			'a.txt',
		);
		expect(r.newContent).toBe('const greeting = \u201cHi\u201d;\nconst x = 1;\n');
		expect(r.newContent.split('\n')[1]).toBe('const x = 1;');
	});

	it('line endings: CRLF preserved on input + LF internally', () => {
		const r = restoreLineEndings('a\nb\nc', '\r\n');
		expect(r).toBe('a\r\nb\r\nc');
	});

	it('detectLineEnding 认首个行尾（CRLF 优先于后续 LF）', () => {
		expect(detectLineEnding('a\r\nb\n')).toBe('\r\n');
		expect(detectLineEnding('a\nb\r\n')).toBe('\n');
		expect(detectLineEnding('no newline')).toBe('\n');
	});

	it('splitBom strips leading BOM', () => {
		const r = splitBom('\ufeffhello');
		expect(r.bom).toBe('\ufeff');
		expect(r.text).toBe('hello');
	});

	it('normalizeToLF collapses CRLF + CR', () => {
		expect(normalizeToLF('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
	});

	it('normalizeForFuzzyMatch: smart quotes → straight quotes', () => {
		expect(normalizeForFuzzyMatch('\u201chello\u201d')).toBe('"hello"');
	});

	it('generateDiffString 带行号 + firstChangedLine', () => {
		const r = generateDiffString('a\nb', 'a\nB');
		expect(r.diff).toBe(' 1 a\n-2 b\n+2 B');
		expect(r.firstChangedLine).toBe(2);
	});
});

describe('Path utilities', () => {
	it('resolveToCwd makes absolute path', () => {
		expect(resolveToCwd('a.txt', '/tmp')).toBe('/tmp/a.txt');
		expect(resolveToCwd('/abs/b.txt', '/tmp')).toBe('/abs/b.txt');
	});

	it('resolveToCwd 归一 . 与 ..（不许穿出根）', () => {
		expect(resolveToCwd('./a/../b.txt', '/work')).toBe('/work/b.txt');
		expect(resolveToCwd('../../etc/passwd', '/work')).toBe('/etc/passwd');
	});

	it('resolveToCwd 保留空格与非 ASCII（URL API 会百分号编码——本仓用 normalizePath）', () => {
		expect(resolveToCwd('my dir/中文 名.txt', '/')).toBe('/my dir/中文 名.txt');
	});
});
