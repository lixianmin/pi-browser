// @vitest-environment node
// P6/P5：compaction 集成验证 —— 阈值触发与切点，改挂到上游 1.0.0 的**纯函数**上。
//
// 为什么重写（0.99.1 → 1.0.0）：原先这个文件让 **pi-agent-core@0.99.1 的 harness 自动压缩**
// （faux provider + `AgentHarness.create` + `JsonlSessionRepo`）在一个 pi-browser fs 支撑的会话上跑一遍。
// 1.0.0 里 `AgentHarness`、`JsonlSessionRepo`、`harness/compaction` 全部消失（agent-core 只剩
// agent / agent-loop / proxy / stream-fn / types），替代者是 CLI 侧 `core/compaction/compaction.js`
// （文件头原文：「Pure functions for compaction logic」）与 `core/session-manager.js` 的
// `SessionManager`——后者是 node:fs 绑定 + 私有构造，跑不了（见 `session-fs-roundtrip.test.ts` 头注）。
//
// 改挂后的分工：
//   · **本文件**：阈值判定（`shouldCompact`）+ 切点与保留尾（`prepareCompaction`）+ 压缩产物消息
//     （自持 `createCompactionSummaryMessage` → 上游 `buildSessionContext` 认得）。三者都是纯函数，
//     不需要 provider / 运行时依赖 —— 原来那套 faux provider 的复杂度没有了。
//   · `session-format-parity.test.ts`：文件格式（`parseSessionEntries` / `buildSessionContext` 往返）。
//   · `session-fs-roundtrip.test.ts`：本仓 fs 的落盘与追加。
import { describe, it, expect } from 'vitest';
import { createCompactionSummaryMessage, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from '../src/compaction/compaction';
import { shouldCompact, prepareCompaction } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import { buildSessionContext } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';

/**
 * 必须显式写死：默认 `reserveTokens: 16384` 配 2048 的 `contextWindow` 会让阈值退化成「恒真」
 * （`contextWindow - reserveTokens` 为负），压缩每轮都触发。这条断言本身就是它的文档。
 */
const SETTINGS: CompactionSettings = { enabled: true, reserveTokens: 256, keepRecentTokens: 128 };
const CONTEXT_WINDOW = 2048;

// pi-ai@1.0.0 的 `Usage.totalTokens` 是**必填**（types.d.ts:302）；漏了它，上游的
// `calculateContextTokens` 会回退到 input+output+…，而测试仍然绿 —— 于是「usage 路径坏掉」这件事
// 会被估算回退掩盖。补上，并让断言断在一个具体数字上（见下面 tokensBefore）。
const usage = (input: number, output: number) => ({
	input, output, cacheRead: 0, cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** 一条 user + 一条 assistant（带 usage，token 估算才非零）组成的条目。 */
const turn = (id: string, parentId: string | null, index: number) => {
	const ts = new Date(1_700_000_000_000 + index * 1000).toISOString();
	return [
		{ type: 'message', id: `${id}-u`, parentId, timestamp: ts, message: { role: 'user', content: `问题 ${index}`.repeat(20), timestamp: index } },
		{
			type: 'message', id: `${id}-a`, parentId: `${id}-u`, timestamp: ts,
			message: {
				role: 'assistant', content: [{ type: 'text', text: `回答 ${index}`.repeat(80) }],
				api: 'faux', provider: 'faux', model: 'faux', usage: usage(400, 300), stopReason: 'stop', timestamp: index,
			},
		},
	];
};

const chain = (turns: number) => {
	const entries: unknown[] = [];
	let parent: string | null = null;
	for (let i = 0; i < turns; i++) {
		for (const e of turn(`t${i}`, parent, i)) {
			entries.push(e);
			parent = (e as { id: string }).id;
		}
	}
	return entries;
};

describe('compaction：阈值触发与切点（上游 1.0.0 纯函数）', () => {
	it('settings 必须写死：上游默认档配 2048 的 contextWindow 会让阈值恒真', () => {
		// 上游 shouldCompact：contextTokens > contextWindow - reserveTokens
		expect(CONTEXT_WINDOW - DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBeLessThan(0);
		expect(shouldCompact(1, CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
		// 写死的档位下阈值才有意义
		expect(CONTEXT_WINDOW - SETTINGS.reserveTokens).toBe(1792);
	});

	it('阈值两侧：低于不动、超过触发、enabled: false 一律不动（逐条对着上游 shouldCompact）', () => {
		expect(shouldCompact(1791, CONTEXT_WINDOW, SETTINGS)).toBe(false);
		expect(shouldCompact(1793, CONTEXT_WINDOW, SETTINGS)).toBe(true);
		expect(shouldCompact(99999, CONTEXT_WINDOW, { ...SETTINGS, enabled: false })).toBe(false);
	});

	it('切点：老对话被 prepareCompaction 判定「有东西可摘要」且保留尾非空', () => {
		const entries = chain(12);
		const preparation = prepareCompaction(entries as never, SETTINGS);
		expect(preparation).toBeDefined();
		if (!preparation) return;
		expect(preparation.messagesToSummarize.length).toBeGreaterThan(0);
		// 切在轮中间（isSplitTurn）：预算 128 从尾部回走累计，80 → 100 → 180 越界，
		// 落点 t10-a 是 assistant（不是 turn 的第一条），于是切点判定为「切在一轮中间」。
		expect(preparation.turnPrefixMessages.length).toBeGreaterThan(0);
		// firstKeptEntryId 必须是真实存在的条目 id
		const ids = entries.map((e) => (e as { id: string }).id);
		expect(ids).toContain(preparation.firstKeptEntryId);
		// 断具体值而不是 `> 0`：末条 assistant 的 usage 是 400+300=700。这条断言实测能区分
		// 「上游走 usage 路径」与「回退到按文本估算」——把夹具里的 usage 整段删掉会得到 1250（红）。
		// （单独删掉 `totalTokens` 不会红：上游的兜底公式是 `totalTokens || input+output+cacheRead+cacheWrite`，
		//   cacheRead=0 时两条路径同值——那是上游的既定语义，不是这条断言的漏洞。）
		expect(preparation.tokensBefore).toBe(700);
		expect(preparation.settings).toEqual(SETTINGS);
	});

	it('已经压过一轮的尾巴再来一次：上游按「末尾已是 compaction」返回 undefined（不会连压）', () => {
		const entries = chain(3);
		expect(prepareCompaction(entries as never, SETTINGS)).toBeDefined();
		const withCompaction = [
			...entries,
			{
				type: 'compaction', id: 'c1', parentId: (entries.at(-1) as { id: string }).id,
				timestamp: '2026-10-02T09:00:00.000Z', summary: '上一轮摘要',
				firstKeptEntryId: 't0-u', tokensBefore: 5000,
			},
		];
		expect(prepareCompaction(withCompaction as never, SETTINGS)).toBeUndefined();
	});

	it('压缩产物：自持 createCompactionSummaryMessage 造的条目能被上游 buildSessionContext 认成 compactionSummary', () => {
		const entries = chain(2);
		const lastId = (entries.at(-1) as { id: string }).id;
		const summary = createCompactionSummaryMessage('这是摘要', 5000, '2026-10-02T09:00:00.000Z');
		expect(summary.role).toBe('compactionSummary');

		const withCompaction = [
			...entries,
			{
				type: 'compaction', id: 'c1', parentId: lastId, timestamp: '2026-10-02T09:00:00.000Z',
				summary: summary.summary, firstKeptEntryId: 't0-u', tokensBefore: summary.tokensBefore,
			},
		];
		const context = buildSessionContext(withCompaction as never);
		const restored = context.messages.find((m) => m.role === 'compactionSummary');
		expect(restored).toMatchObject({ role: 'compactionSummary', summary: '这是摘要' });
		// 上游还原出来的 timestamp 是毫秒数，与我们造的一致（两端都走 new Date(iso).getTime()）
		expect((restored as { timestamp: number }).timestamp).toBe(summary.timestamp);
	});
});
