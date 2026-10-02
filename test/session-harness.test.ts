// @vitest-environment node
// 批 2 B-2：浏览器侧的会话/Harness 装配（`openBrowserHarness` + `asDurableTools` 的 replay 策略）。
//
// 断言三件事：
//   ① 装配开得出一个**能跑的** Harness：root conversation → 提交一条输入 → 读回 entry。真链路、无网络
//      （`Models` 用替身，逐轮返回脚本化的 assistant 消息）。
//   ② 工具**真的被调用**：脚本第一轮发一个 `read` 的 toolCall，`Harness` 自己排 `ToolTask` 跑它，
//      结果 entry 里出现文件内容 —— 这一条把 B-1 存储 / B-3 接线 / B-2 装配接成了一条链。
//   ③ replay 策略：只读工具标 `safe`，副作用工具**不标**（不标 = 缺省 `unsafe`，见 `asDurableTools` 的注释）。
import { describe, it, expect } from 'vitest';
import { createRegistry } from '@earendil-works/pi-durable';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Model, Models, ToolCall } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import {
	asDurableTools,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	openBrowserHarness,
	openBrowserSessionStorage,
} from '../src/index';
import { editOps, findOps, grepOps, lsOps, readOps, writeOps } from './helpers/tool-operations';

const CTX = BACKGROUND_CONTEXT;
const MODEL: Model<'pi-messages'> = {
	id: 'faux-1',
	name: 'faux',
	api: 'pi-messages',
	provider: 'faux',
	baseUrl: 'faux://',
	input: ['text'],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 8_000,
};
const USAGE = {
	input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const message = (
	content: AssistantMessage['content'],
	stopReason: Extract<AssistantMessage['stopReason'], 'stop' | 'toolUse'>,
): AssistantMessage => ({
	role: 'assistant',
	content,
	api: 'pi-messages',
	provider: 'faux',
	model: MODEL.id,
	timestamp: 1,
	usage: USAGE,
	stopReason,
});

/** 替身 `Models`：按脚本逐轮返回预置消息（最后一轮重复），不碰网络、不认任何 provider。 */
const fauxModels = (turns: AssistantMessage[]): Models => {
	let turn = 0;
	return {
		getModel: () => MODEL,
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			const terminal = turns[Math.min(turn++, turns.length - 1)];
			// `done` 事件带终值 `message`（= `result()`）；`reason` 是本测试脚本只用到的两个正常终止档
			stream.push({ type: 'done', reason: terminal.stopReason as 'stop' | 'toolUse', message: terminal });
			stream.end(terminal);
			return stream;
		},
	} as unknown as Models;
};

/** 开一个装配好的 Harness：B-1 存储（内存后端，够跑）+ B-3 工具 + 本文件的替身模型。 */
const openHarness = async (turns: AssistantMessage[], tools: AgentTool<any, any>[]) => {
	const storage = await openBrowserSessionStorage('/sessions/b2', createMemoryFileSystem(), CTX);
	const registry = createRegistry();
	registry.install({ name: 'browser', tools: asDurableTools(tools) });
	const harness = await openBrowserHarness({
		models: fauxModels(turns),
		registry,
		storage,
		context: CTX,
		// 逐次调用构造：本仓的执行环境由调用方造，装配只转发（会话工作目录经 `target.cwd` 到达这里）
		env: () => undefined,
	});
	return harness;
};

const sevenTools = (fs: BrowserFileSystem): AgentTool<any, any>[] => [
	createReadTool('/', { operations: readOps(fs) }),
	createWriteTool('/', { operations: writeOps(fs) }),
	createEditTool('/', { operations: editOps(fs) }),
	createGrepTool('/', { fs }),
	createLsTool('/', { operations: lsOps(fs) }),
	createFindTool('/', { operations: findOps(fs) }),
	createBashTool('/', { operations: { exec: async () => ({ exitCode: 0 }) } }),
];

const toolCall = (id: string, name: string, args: Record<string, unknown>): ToolCall =>
	({ type: 'toolCall', id, name, arguments: args as ToolCall['arguments'] });

describe('浏览器侧的会话/Harness 装配（批 2 B-2）', () => {
	it('开 Harness → root conversation → 提交输入 → 生成 → entry 读回（模型是替身，无网络）', async () => {
		const harness = await openHarness(
			[message([{ type: 'text', text: '收到' }], 'stop')],
			[createReadTool('/', { operations: readOps(createMemoryFileSystem()) })],
		);

		const conversation = await harness.root(CTX, { agent: { model: { provider: 'faux', modelId: MODEL.id } } });
		const submission = await conversation.submit({ type: 'input', content: '你好，浏览器' }, CTX);
		const settled = await submission.wait(CTX);

		expect(settled.status).toBe('done');
		const page = await conversation.entries({}, 20, undefined, CTX);
		// 上游把 transcript 拆成 entry：`pi.user`（用户输入）、`pi.system`（工具面/提示）、`pi.assistant`、
		// `pi.tool-result`；`entries` 新est-first。模型消息在 entry 的 `model` 上。
		expect(page.items.map((entry) => entry.kind)).toContain('pi.user');
		const user = page.items.find((entry) => entry.kind === 'pi.user');
		expect(user?.model?.[0]).toMatchObject({ role: 'user', content: '你好，浏览器' });

		await harness.close(CTX);
	});

	it('工具真的被调用：脚本里的 read toolCall 由 Harness 自己跑完，结果 entry 里有文件内容', async () => {
		const fs = createMemoryFileSystem();
		const written = await fs.writeFile('/notes.txt', '浏览器里的一句话', CTX);
		expect(written.ok).toBe(true);

		const harness = await openHarness(
			[
				message([toolCall('call-1', 'read', { path: '/notes.txt' })], 'toolUse'),
				message([{ type: 'text', text: '读到了' }], 'stop'),
			],
			[createReadTool('/', { operations: readOps(fs) })],
		);

		const conversation = await harness.root(CTX, { agent: { model: { provider: 'faux', modelId: MODEL.id } } });
		const settled = await (await conversation.submit({ type: 'input', content: '读一下 /notes.txt' }, CTX)).wait(CTX);
		expect(settled.status).toBe('done');

		const page = await conversation.entries({}, 50, undefined, CTX);
		const results = page.items.filter((entry) => entry.kind === 'pi.tool-result');
		expect(results).toHaveLength(1);
		expect(results[0].model?.[0]).toMatchObject({
			role: 'toolResult',
			toolCallId: 'call-1',
			toolName: 'read',
			isError: false,
		});
		expect(results[0].model?.[0].content).toEqual([{ type: 'text', text: '浏览器里的一句话' }]);

		await harness.close(CTX);
	});

	it('replay 策略：只读工具 `safe`，write/edit/bash 不标（缺省 `unsafe`）', () => {
		const tools = asDurableTools(sevenTools(createMemoryFileSystem()));
		const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.replay]));
		expect(byName).toEqual({
			read: 'safe',
			grep: 'safe',
			ls: 'safe',
			find: 'safe',
			write: undefined,
			edit: undefined,
			bash: undefined,
		});
	});
});
