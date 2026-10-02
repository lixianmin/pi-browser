// @vitest-environment node
// 批 2 B-4：compaction 接缝 —— durable 内建 CompactionTask 真的被驱动起来。
//
// 断言三件事：
//   ① 公开面上那份 `DEFAULT_BROWSER_COMPACTION_POLICY` 逐字段等于 durable 的 `DEFAULT_COMPACTION_POLICY`
//      （四字段，含 `backgroundTokens`），并**明确不等于**本仓自持副本的 `DEFAULT_COMPACTION_SETTINGS`
//      （那份三字段，少 `backgroundTokens`）——上游改数值这里就红。
//   ② 压缩真的跑得起来：不传 `settings.compaction` 时，Harness 仍按 durable 的缺省策略跑起一次 threshold
//      compaction，产出 `pi.compaction` 条目——且摘要消息是 durable 自己造的 `[UserMessage]`
//      （不是本仓那份 `createCompactionSummaryMessage` 的 `compactionSummary` 角色）。
//   ③ `backgroundTokens: 32768` 真被读到：窗口调到只够越过后台阈值时压得动，压到 `0` 就不动；
//      调用方给的 `enabled: false` 优先于缺省。
// 装配层**不**再 merge 一份浏览器侧默认（那份与 durable 缺省逐字同值，merge 与不 merge 同产出），
// 所以这里没有「装配传了什么」的白盒断言：那类断言验的是实现形状，不是行为。
import { describe, it, expect } from 'vitest';
import { DEFAULT_COMPACTION_POLICY, createRegistry } from '@earendil-works/pi-durable';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Model, Models } from '@earendil-works/pi-ai';
import type { Conversation, EntryRecord, HarnessSettings } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { DEFAULT_BROWSER_COMPACTION_POLICY, openBrowserHarness, openBrowserSessionStorage } from '../src/index';
import { DEFAULT_COMPACTION_SETTINGS } from '../src/compaction/compaction';

const CTX = BACKGROUND_CONTEXT;
const SUMMARY_TEXT = '## Goal\n把浏览器那端的 pi-durable 接缝接通。';

/** 只有 `contextWindow` 不同：durable 的 `thresholdCompaction`（`dist/harness/generation.js:216-218`）算
 *  `blocking = contextWindow - reserveTokens`、`background = blocking - backgroundTokens`。 */
const model = (contextWindow: number): Model<'pi-messages'> => ({
	id: `faux-${contextWindow}`,
	name: 'faux',
	api: 'pi-messages',
	provider: 'faux',
	baseUrl: 'faux://',
	input: ['text'],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow,
	maxTokens: 2_048,
});

const message = (text: string): AssistantMessage => ({
	role: 'assistant',
	content: [{ type: 'text', text }],
	api: 'pi-messages',
	provider: 'faux',
	model: 'faux',
	timestamp: 1,
	usage: {
		input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: 'stop',
});

/**
 * 替身 `Models`：`streamSimple` 给每轮发一条脚本消息；`completeSimple` 是 durable 的 `CompactionTask`
 * 摘要那一步真正调的入口（`compaction.js` 的 `runtime.models.completeSimple`）——不实现它，压缩会停在
 * `summarize` 相位拿不到摘要。
 */
const fauxModels = (target: Model<'pi-messages'>): Models => {
	let turn = 0;
	return {
		getModel: () => target,
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			const terminal = message(`第 ${++turn} 轮`);
			stream.push({ type: 'done', reason: 'stop', message: terminal });
			stream.end(terminal);
			return stream;
		},
		completeSimple: async () => message(SUMMARY_TEXT),
	} as unknown as Models;
};

/**
 * `keepRecentTokens: 20000` 是默认策略的值，`selectCut` 按 `estimateMessageTokens`（字符数 / 4）从尾部
 * 往前累计，所以历史里必须真有 ~8 万字符才够「有东西可切」。
 */
const LONG_TURN = 'x'.repeat(90_000);

/** 读出 `pi.compaction` 条目；`pollFirst` 为真时最多等 2 秒（后台压缩不阻塞生成，条目会晚一点落）。 */
const findCompaction = async (
	conversation: Conversation,
	pollFirst: boolean,
): Promise<EntryRecord | undefined> => {
	if (pollFirst) {
		let found: EntryRecord | undefined;
		await expect.poll(async () => {
			found = (await conversation.entries({}, 50, undefined, CTX)).items.find((e) => e.kind === 'pi.compaction');
			return found !== undefined;
		}, { timeout: 2_000, interval: 20 }).toBe(true);
		return found;
	}
	return (await conversation.entries({}, 50, undefined, CTX)).items.find((entry) => entry.kind === 'pi.compaction');
};

/**
 * 跑两轮**长**提交，返回有没有 `pi.compaction` 条目。
 *
 * 两轮都长是必需的，不是冗余：`selectCut` 从尾部回走凑 `keepRecentTokens`，落点切到 `cut` 后还要检查
 * 「`cut` 之前存在非空的 contribution」才认这个切点（`compaction.js` 末尾那两个循环）——切点不能是 0，
 * 头几条 entry 得是能当切点前驱的真实内容。**单轮**长文切出来正好是 0，于是不压。
 */
const runTwoTurns = async (
	dir: string,
	contextWindow: number,
	options: { settings?: HarnessSettings; pollFirst?: boolean } = {},
): Promise<EntryRecord | undefined> => {
	const storage = await openBrowserSessionStorage(dir, createMemoryFileSystem(), CTX);
	const target = model(contextWindow);
	const harness = await openBrowserHarness({
		models: fauxModels(target),
		registry: createRegistry(),
		storage,
		context: CTX,
		...(options.settings === undefined ? {} : { settings: options.settings }),
	});
	const conversation = await harness.root(CTX, { agent: { model: { provider: 'faux', modelId: target.id } } });
	await (await conversation.submit({ type: 'input', content: LONG_TURN }, CTX)).wait(CTX);
	await (await conversation.submit({ type: 'input', content: LONG_TURN }, CTX)).wait(CTX);
	const compaction = await findCompaction(conversation, options.pollFirst === true);
	await harness.close(CTX);
	return compaction;
};

describe('compaction 接缝：durable 的 CompactionTask（批 2 B-4）', () => {
	it('公开面上那份默认逐字段等于 durable 的 DEFAULT_COMPACTION_POLICY，且不等于自持副本那三字段', () => {
		expect(DEFAULT_BROWSER_COMPACTION_POLICY).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
			backgroundTokens: 32768,
		});
		// 逐条对着上游真常量断言（不是自说自话的重复）：上游改数值这里就红
		expect(DEFAULT_BROWSER_COMPACTION_POLICY).toEqual(DEFAULT_COMPACTION_POLICY);
		// 与本仓自持副本的关系：三字段同名同值，**多一个** `backgroundTokens`
		expect(DEFAULT_COMPACTION_SETTINGS).toEqual({
			enabled: DEFAULT_BROWSER_COMPACTION_POLICY.enabled,
			reserveTokens: DEFAULT_BROWSER_COMPACTION_POLICY.reserveTokens,
			keepRecentTokens: DEFAULT_BROWSER_COMPACTION_POLICY.keepRecentTokens,
		});
		expect(Object.keys(DEFAULT_BROWSER_COMPACTION_POLICY).sort())
			.toEqual(['backgroundTokens', 'enabled', 'keepRecentTokens', 'reserveTokens']);
		expect(Object.keys(DEFAULT_COMPACTION_SETTINGS)).not.toContain('backgroundTokens');
	});

	it('不传 settings.compaction 也压得动：durable 的 CompactionTask 真的跑起来并自己造摘要消息', async () => {
		// contextWindow 8192 < reserveTokens 16384 → `blocking` 为负，每轮都越界（必压的那一档）。
		// 阻塞压缩由本代生成等它结算，所以 `wait()` 返回时条目已经落盘，不必轮询。
		const compaction = await runTwoTurns('/sessions/b4-blocking', 8_192);
		expect(compaction).toBeDefined();
		// 摘要消息由 durable 构造：`CompactionEntry` 的 `model` 是一条**带摘要的 user 消息**
		// （`compaction.js` 的 `placeSummary`），不是本仓那份 `compactionSummary` 角色。
		expect(compaction?.model).toHaveLength(1);
		expect(compaction?.model?.[0]).toMatchObject({ role: 'user' });
		const text = (compaction?.model?.[0] as { content: Array<{ type: string; text?: string }> }).content[0];
		expect(text.type).toBe('text');
		expect(text.text).toContain(SUMMARY_TEXT);
		expect(text.text).toContain('<summary>');
		// 没有一条 role 为 compactionSummary 的消息：那条路只属于 CLI 侧的 core/messages
		expect(compaction?.model?.some((m) => (m as { role: string }).role === 'compactionSummary')).toBe(false);
	});

	it('backgroundTokens: 32768 真被读到：只越过后台阈值（没越阻塞阈值）也压', async () => {
		// contextWindow 40000 → blocking = 23616、background = 10848；两轮长文的上下文约 2.3 万 token，
		// 落在两者之间：只有「后台阈值 + backgroundTokens > 0」这一条路能触发。
		expect(await runTwoTurns('/sessions/b4-background', 40_000, { pollFirst: true })).toBeDefined();
	});

	it('调用方覆盖优先：enabled: false 后阻塞链路不再压；backgroundTokens 压到 0 后台也不压', async () => {
		// 阻塞档：压缩若发生必在 `wait()` 返回前落盘，所以此刻没有就是没有（不是时序问题）
		expect(await runTwoTurns('/sessions/b4-off', 8_192, { settings: { compaction: { enabled: false } } })).toBeUndefined();
		// 后台档：把 `backgroundTokens` 压到 0（durable 语义：关掉后台压缩）后同一个窗口不再压
		expect(await runTwoTurns('/sessions/b4-nobg', 40_000, { settings: { compaction: { backgroundTokens: 0 } } })).toBeUndefined();
	});
});
