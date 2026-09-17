// @vitest-environment node
// S4 spec §3.3 / §4.4：compaction 集成验证——不直接调 `compact`/`prepareCompaction`（那条路要 pi-ai 运行时依赖），
// 而是让 **harness 自己的自动压缩**在一个 pi-browser fs 支撑的会话上跑一遍：faux provider 供两条脚本化响应
// （普通回复 + 摘要），断言 ① 阈值压缩被触发 ② 落盘 `compaction` 条目且 `retainedTail` 非空 ③ 压缩产物是
// `compactionSummary` 角色消息。devDependency `@earendil-works/pi-ai` 只为构造 faux provider 存在。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, AgentHarness, JsonlSessionRepo, type CompactionSettings } from '@earendil-works/pi-agent-core';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createBrowserFileSystem, createCompactionSummaryMessage, DEFAULT_COMPACTION_SETTINGS } from '../src/index';

const CTX = BACKGROUND_CONTEXT;

/**
 * 必须显式写死：默认 `reserveTokens: 16384` 配 2048 的 `contextWindow` 会让阈值退化成「恒真」
 * （`contextWindow - reserveTokens` 为负），压缩每轮都触发。
 */
const SETTINGS: CompactionSettings = { enabled: true, reserveTokens: 256, keepRecentTokens: 128 };
const CONTEXT_WINDOW = 2048;
const SUMMARIZATION_MARK = 'context summarization assistant';

/** 每轮一条普通回复；摘要请求（systemPrompt 是上游的 SUMMARIZATION_SYSTEM_PROMPT）走摘要文本 */
const responses = (count: number) => Array.from({ length: count }, () => (context: { systemPrompt?: string }) =>
	fauxAssistantMessage((context.systemPrompt ?? '').includes(SUMMARIZATION_MARK) ? '摘要是这样的' : '回复内容'.repeat(300)));

describe('compaction：harness 自动压缩在浏览器 fs 会话上的集成验证', () => {
	it('跨过阈值 → 压缩条目落盘（retainedTail 非空）→ flush 后新实例仍读得回', async () => {
		const fs = createBrowserFileSystem({ dbName: 'compaction-integration', memory: true });
		const repo = new JsonlSessionRepo({ fileSystem: fs, sessionsRoot: '/sessions' });
		const session = await repo.create({ id: 's1', cwd: '/' }, CTX);

		const faux = fauxProvider({ models: [{ id: 'faux', contextWindow: CONTEXT_WINDOW, maxTokens: 512 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(responses(40));

		const { harness } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
			compaction: SETTINGS,
			systemPrompt: 'sys',
		}, CTX);
		const events: string[] = [];
		harness.events.on('compaction_start', (e) => { events.push(`start:${e.reason}`); });
		harness.events.on('compaction_end', (e) => { events.push(`end:${e.status}`); });
		// 设置透出：harness 里跑的就是上面写死的那份（默认值不会悄悄顶掉）
		expect(await harness.getCompactionSettings(CTX)).toEqual(SETTINGS);
		expect(DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);

		const lane = await harness.lane('main', { createAt: null }, CTX);
		// 每轮 ~2800 字符（≈700 tokens）：两轮就跨过 2048 - 256 的阈值
		for (let turn = 0; turn < 2; turn++) {
			const run = await lane.prompt(`第${turn}轮：` + '内容'.repeat(800), undefined, CTX);
			expect(run.ok, `第 ${turn} 轮失败`).toBe(true);
		}

		expect(events).toContain('start:threshold');
		expect(events).toContain('end:completed');
		await harness.close(CTX);
		await fs.flush();

		// 新实例（= 刷新页面后重建 fs）读回：压缩条目与压缩前的消息都在 IDB/内存后端上
		const reopenedRepo = new JsonlSessionRepo({ fileSystem: fs, sessionsRoot: '/sessions' });
		const meta = (await reopenedRepo.list(undefined, CTX)).find((m) => m.id === 's1');
		expect(meta).toBeDefined();
		const reopened = await reopenedRepo.open(meta!, CTX);
		const entries = await reopened.findEntries({ order: 'asc' }, CTX);
		const compaction = entries.find((e) => e.type === 'compaction');
		expect(compaction?.type).toBe('compaction');
		if (compaction?.type !== 'compaction') return;

		expect(compaction.tokensBefore).toBeGreaterThan(CONTEXT_WINDOW - SETTINGS.reserveTokens);
		expect(compaction.retainedTail.length).toBeGreaterThan(0);
		expect(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp).role).toBe('compactionSummary');

		await reopenedRepo.close(CTX);
		await fs.cleanup(CTX);
	});
});
