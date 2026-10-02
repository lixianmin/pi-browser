// T1.2：OutputAccumulator —— 上游 pi-coding-agent@1.0.0 `dist/core/tools/output-accumulator.js` 的转写。
// 平台偏差（spec D1/D2）：`append` 收 Uint8Array（上游收 Buffer）；spill 走注入 seam（上游直接 node:os + node:fs）。
import { describe, it, expect } from 'vitest';
import { OutputAccumulator, createMountSpill } from '../src/shell/output-accumulator';
import { createMountTable } from '../src/env/mount';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';   // T1.4 换到 ../src/env/context

const enc = (s: string) => new TextEncoder().encode(s);

/** 造一套独立的内存挂载表 + 基于它的 spill（/tmp 落盘） */
function memSpill() {
	const table = createMountTable([
		{ prefix: '/', fs: createMemoryFileSystem('/') },
		{ prefix: '/tmp', fs: createMemoryFileSystem('/tmp') },
	]);
	return { table, spill: createMountSpill(table, 'pi-bash') };
}

describe('OutputAccumulator', () => {
	it('流式分片累积，finish 后 snapshot 给完整内容', () => {
		const acc = new OutputAccumulator({ maxLines: 100, maxBytes: 1000 });
		acc.append(enc('hel'));
		acc.append(enc('lo\n'));
		acc.finish();
		const snap = acc.snapshot();
		expect(snap.content).toBe('hello\n');
		expect(snap.truncation.truncated).toBe(false);
		expect(snap.truncation.truncatedBy).toBeNull();
		expect(snap.fullOutputPath).toBeUndefined();
	});

	it('跨分片的多字节字符不被拆断', () => {
		const acc = new OutputAccumulator();
		const bytes = enc('中文');
		acc.append(bytes.slice(0, 2));   // 切在 UTF-8 序列中间
		acc.append(bytes.slice(2));
		acc.finish();
		expect(acc.snapshot().content).toBe('中文');
	});

	it('超过字节上限时 content 是尾部（截断后不带尾换行）', () => {
		const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 5 });
		acc.append(enc('aaaa\nbbbb\n'));
		acc.finish();
		const snap = acc.snapshot();
		expect(snap.truncation.truncated).toBe(true);
		expect(snap.truncation.truncatedBy).toBe('bytes');
		expect(snap.content).toBe('bbbb');
	});

	it('超过行数上限时 truncatedBy 是 lines', () => {
		const acc = new OutputAccumulator({ maxLines: 2, maxBytes: 1e6 });
		acc.append(enc('a\nb\nc\nd\n'));
		acc.finish();
		const snap = acc.snapshot();
		expect(snap.truncation.truncatedBy).toBe('lines');
		expect(snap.content).toBe('c\nd');
	});

	// Review Focus #4：单行超上限时 lastLineBytes 与展示面分开断言
	it('单行超上限时 lastLinePartial 置位，getLastLineBytes 给该行原始字节数', () => {
		const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 8 });
		acc.append(enc('x'.repeat(20)));
		acc.finish();
		const snap = acc.snapshot();
		expect(snap.truncation.lastLinePartial).toBe(true);
		expect(snap.content).toBe('x'.repeat(8));
		expect(acc.getLastLineBytes()).toBe(20);
	});

	it('finish 之后再 append 响亮抛错', () => {
		const acc = new OutputAccumulator();
		acc.finish();
		expect(() => acc.append(enc('x'))).toThrow(/finished/);
	});

	it('接了 spill 时：超限即产生 fullOutputPath（虚拟路径），且能读回全文', async () => {
		const { table, spill } = memSpill();
		const acc = new OutputAccumulator({ maxLines: 2, maxBytes: 100, tempFilePrefix: 'pi-test' }, spill);
		acc.append(enc('a\nb\nc\nd\n'));
		acc.finish();
		const snap = acc.snapshot({ persistIfTruncated: true });
		expect(snap.fullOutputPath?.startsWith('/tmp/')).toBe(true);

		await acc.closeTempFile();
		const read = await table.readTextFile(snap.fullOutputPath!, BACKGROUND_CONTEXT);
		expect(read).toEqual({ ok: true, value: 'a\nb\nc\nd\n' });

		const full = await acc.readFullOutput(1000);
		expect(full).toEqual({ content: 'a\nb\nc\nd\n', truncated: false });
	});

	it('未接 spill 时：超限只截断展示，不落盘、不抛', () => {
		const acc = new OutputAccumulator({ maxLines: 2, maxBytes: 100 });
		acc.append(enc('a\nb\nc\nd\n'));
		acc.finish();
		const snap = acc.snapshot({ persistIfTruncated: true });
		expect(snap.truncation.truncated).toBe(true);
		expect(snap.fullOutputPath).toBeUndefined();
	});

	it('readFullOutput 未落盘时给原文且 truncated=false', async () => {
		const acc = new OutputAccumulator({ maxLines: 100, maxBytes: 1000 });
		acc.append(enc('short\n'));
		acc.finish();
		await expect(acc.readFullOutput(1000)).resolves.toEqual({ content: 'short\n', truncated: false });
	});

	it('readFullOutput 超出 maxBytes 时保留首尾并插省略标记', async () => {
		const { spill } = memSpill();
		const acc = new OutputAccumulator({ maxLines: 2, maxBytes: 4 }, spill);
		acc.append(enc('0123456789abcdef'));
		acc.finish();
		acc.snapshot({ persistIfTruncated: true });
		await acc.closeTempFile();
		const full = await acc.readFullOutput(8);
		expect(full.truncated).toBe(true);
		expect(full.content.startsWith('0123')).toBe(true);
		expect(full.content.endsWith('cdef')).toBe(true);
		expect(full.content).toContain('8 bytes omitted');   // 上游原文标记：`[... N bytes omitted ...]`
	});

	it('createMountSpill 把全量写进 /tmp 并返回可读回的虚拟路径', async () => {
		const { table, spill } = memSpill();
		const file = spill.create('pi-bash');
		file.append(enc('full output\n'));
		await file.close();
		expect(file.path.startsWith('/tmp/')).toBe(true);
		await expect(table.readTextFile(file.path, BACKGROUND_CONTEXT)).resolves.toEqual({ ok: true, value: 'full output\n' });
	});

	it('createMountSpill 的两次 create 路径互不相同', () => {
		const { spill } = memSpill();
		expect(spill.create('p').path).not.toBe(spill.create('p').path);
	});
});
