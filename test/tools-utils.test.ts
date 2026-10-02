// Task 5 平移（P2a 后只剩截断一块）：spice `packages/harness/test/agent-tools.test.ts` 的
// 「Truncation utilities」块，断言语义逐字保留（去除 spice 域条目：isReadOnlyPath 与 Resource 相关断言）。
// P2a（Task 9/10）已把「Edit-diff utilities」搬到 test/edit-diff.test.ts、「Path utilities」搬到 test/path-utils.test.ts。
import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine, truncateMiddle, truncateTail, utf8ByteLength } from '../src/tools/truncate';

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

	it('utf8ByteLength 按 UTF-8 计长（ASCII / 三字节 / 代理对）', () => {
		expect(utf8ByteLength('abc')).toBe(3);
		expect(utf8ByteLength('中')).toBe(3);
		expect(utf8ByteLength('\u{1D11E}')).toBe(4);   // 𝄞，代理对
		expect(utf8ByteLength('')).toBe(0);
	});
});

describe('truncateTail（T1.1；对齐上游 harness/utils/truncate.js:178）', () => {
	it('不超限时原样返回且 truncated=false', () => {
		const r = truncateTail('l1\nl2\n');
		expect(r.content).toBe('l1\nl2\n');
		expect(r.truncated).toBe(false);
		expect(r.truncatedBy).toBeNull();
		expect(r.outputLines).toBe(2);
		expect(r.lastLinePartial).toBe(false);
	});

	it('按行数截断时保留尾部', () => {
		const r = truncateTail('a\nb\nc\nd', { maxLines: 2 });
		expect(r.content).toBe('c\nd');
		expect(r.truncatedBy).toBe('lines');
		expect(r.totalLines).toBe(4);
		expect(r.outputLines).toBe(2);
	});

	// Review Focus #4：单行超字节上限时从尾部取部分行——三件事一起断言
	it('单行超字节上限时从尾部取部分行并置 lastLinePartial', () => {
		const r = truncateTail('x'.repeat(100), { maxBytes: 10 });
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe('bytes');
		expect(r.lastLinePartial).toBe(true);
		expect(r.outputLines).toBe(1);
		expect(r.content).toBe('x'.repeat(10));
		expect(r.outputBytes).toBe(10);
		expect(utf8ByteLength(r.content)).toBe(10);
	});

	it('多字节字符不会被截断成半个字符', () => {
		const r = truncateTail('中'.repeat(10), { maxBytes: 7 });
		expect(r.lastLinePartial).toBe(true);
		expect(utf8ByteLength(r.content)).toBeLessThanOrEqual(7);
		expect(r.content).toBe('中'.repeat(2));   // 7 字节只放得下 2 个三字节字符
	});
});

describe('truncateMiddle（P2a-1；对齐上游 pi-coding-agent@1.0.0 core/tools/truncate.js:219）', () => {
	it('不超限时原样返回', () => {
		const r = truncateMiddle('hello\nworld\n', 1000);
		expect(r).toEqual({ content: 'hello\nworld\n', truncated: false, removedChars: 0, totalBytes: 12, totalLines: 2 });
	});

	it('超限时保留头尾、中间换成 …N chars truncated… 标记', () => {
		const r = truncateMiddle('x'.repeat(100), 10);
		expect(r).toEqual({ content: 'xxxxx…90 chars truncated…xxxxx', truncated: true, removedChars: 90, totalBytes: 100, totalLines: 1 });
	});

	it('只在字符边界切（CJK：7 字节放下 3 字节头 + 3 字节尾）', () => {
		const r = truncateMiddle('中'.repeat(10), 7);
		expect(r).toEqual({ content: '中…8 chars truncated…中', truncated: true, removedChars: 8, totalBytes: 30, totalLines: 1 });
	});

	it('removedChars 按码点计（astral 字符记 1）', () => {
		const r = truncateMiddle('😀'.repeat(10), 10);
		expect(r).toEqual({ content: '😀…8 chars truncated…😀', truncated: true, removedChars: 8, totalBytes: 40, totalLines: 1 });
	});

	it('maxBytes = 0 → 全删中段（两条 while 入口的边界）', () => {
		expect(truncateMiddle('abc', 0)).toEqual({ content: '…3 chars truncated…', truncated: true, removedChars: 3, totalBytes: 3, totalLines: 1 });
	});
});
