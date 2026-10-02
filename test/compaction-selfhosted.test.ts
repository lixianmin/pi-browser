// test/compaction-selfhosted.test.ts —— 自持 compaction 与上游 1.0.0 的逐字对照（P4）。
//
// 手法同 P2 的「静态契约面 import 上游产物逐字比对」：直接 import 上游 `dist/core/messages.js`
// （该文件零 node 内建，vitest 里能 import；用相对路径绕开 pi-coding-agent 的 `exports` 白名单），
// 逐条比对我们自持的实现体。目的是**让 P6 升版本时不必再回忆形状**，也防止自持副本悄悄漂移。
import { describe, it, expect } from 'vitest';
import {
	DEFAULT_COMPACTION_SETTINGS, createCompactionSummaryMessage, type CompactionSettings,
} from '../src/compaction/compaction';
import * as upstreamMessages from '../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js';

describe('createCompactionSummaryMessage 与上游 1.0.0 逐字一致', () => {
	it('字段集合与取值逐字（role / summary / tokensBefore / timestamp）', () => {
		const ours = createCompactionSummaryMessage('摘要', 1234, '2026-10-02T08:00:00.000Z');
		const theirs = upstreamMessages.createCompactionSummaryMessage('摘要', 1234, '2026-10-02T08:00:00.000Z');
		expect(ours).toEqual(theirs);
		expect(Object.keys(ours).sort()).toEqual(Object.keys(theirs).sort());
		expect(ours.role).toBe('compactionSummary');
	});

	it('多组输入下逐条一致（不同 summary / tokens / timestamp 形态）', () => {
		const cases: Array<[string, number, string]> = [
			['', 0, '1970-01-01T00:00:00.000Z'],
			['a'.repeat(5000), 999999, '2026-01-02T03:04:05.000Z'],
			['多字节中文摘要', 42, '2026-12-31T23:59:59.999Z'],
		];
		for (const [summary, tokensBefore, timestamp] of cases) {
			expect(createCompactionSummaryMessage(summary, tokensBefore, timestamp))
				.toEqual(upstreamMessages.createCompactionSummaryMessage(summary, tokensBefore, timestamp));
		}
	});

	it('timestamp 恒为毫秒数（ISO 字符串 → epoch ms）', () => {
		const r = createCompactionSummaryMessage('s', 1, '2026-10-02T08:00:00.000Z');
		expect(typeof r.timestamp).toBe('number');
		expect(r.timestamp).toBe(Date.parse('2026-10-02T08:00:00.000Z'));
	});
});

describe('DEFAULT_COMPACTION_SETTINGS', () => {
	it('三字段逐字（enabled / reserveTokens / keepRecentTokens）', () => {
		expect(DEFAULT_COMPACTION_SETTINGS).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
		expect(Object.keys(DEFAULT_COMPACTION_SETTINGS).sort()).toEqual(['enabled', 'keepRecentTokens', 'reserveTokens']);
	});

	it('可赋值给 CompactionSettings（类型面与常量一致）', () => {
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, enabled: false };
		expect(settings.enabled).toBe(false);
	});
});
