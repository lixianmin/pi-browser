// @vitest-environment node
// S5 spec §3.1（Task 2b）：`toHarnessTool` —— `AgentTool` → `AgentHarnessTool` 适配。
//
// 两侧 execute 签名不同（harness 第三参是 onUpdate，不是 AbortSignal；后面还多两个入参），所以不做隐式适配：
// ① 单元——喂假调用上下文，断言 4 参映射（signal 来自 `context.abortSignal`）、onUpdate 透传、元数据原样、异常不吞；
// ② 端到端——真 `AgentHarness` + faux provider：模型调用适配后的工具，断言工具真被执行且结果回到对话里。
import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import {
	AgentHarness, BACKGROUND_CONTEXT, JsonlSessionRepo, withAbortSignal,
	type AgentHarnessToolInvocation, type AgentTool,
} from '@earendil-works/pi-agent-core';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createBrowserFileSystem } from '../src/index';
import { toHarnessTool } from '../src/extensions/harness-tool';

const CTX = BACKGROUND_CONTEXT;
const echoSchema = Type.Object({ text: Type.String() });

const INVOCATION: AgentHarnessToolInvocation = {
	invocationId: 'inv-1',
	operationId: 'op-1',
	turnId: 'turn-1',
	getMemo: async () => undefined,
	setMemo: async () => {},
};

describe('toHarnessTool：签名映射', () => {
	it('六参 execute 压成四参：signal 取 context.abortSignal，onUpdate 原样透传，元数据原样带过', async () => {
		const controller = new AbortController();
		const seen: unknown[] = [];
		const updates: string[] = [];
		const tool: AgentTool<typeof echoSchema, { tag: string }> = {
			name: 'Echo',
			label: 'Echo（回显）',
			description: '回显 text 参数',
			parameters: echoSchema,
			execute: async (toolCallId, input, signal, onUpdate) => {
				seen.push(toolCallId, input, signal);
				onUpdate?.({ content: [{ type: 'text', text: 'partial' }], details: { tag: 'partial' } });
				return { content: [{ type: 'text', text: `echo:${input.text}` }], details: { tag: 'done' } };
			},
		};

		const harnessTool = toHarnessTool(tool);
		expect(harnessTool.name).toBe('Echo');
		expect(harnessTool.label).toBe('Echo（回显）');
		expect(harnessTool.description).toBe('回显 text 参数');
		expect(harnessTool.parameters).toBe(echoSchema);

		const result = await harnessTool.execute(
			'call-1', { text: 'hi' }, (partial) => updates.push((partial.content[0] as { text: string }).text), undefined, INVOCATION,
			withAbortSignal(controller.signal, CTX),
		);

		expect(seen[0]).toBe('call-1');
		expect(seen[1]).toEqual({ text: 'hi' });
		expect(seen[2]).toBe(controller.signal); // 父 run 的取消信号真到了工具里
		expect(updates).toEqual(['partial']);    // harness 进度回调与工具的 onUpdate 同一条
		expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
		expect(result.details).toEqual({ tag: 'done' });
	});

	it('context 上没有信号时 signal 是 undefined（不伪造 AbortSignal）', async () => {
		let received: AbortSignal | undefined = new AbortController().signal;
		const harnessTool = toHarnessTool({
			name: 'Probe', label: 'Probe', description: '探针', parameters: echoSchema,
			execute: async (_id, _input, signal) => { received = signal; return { content: [], details: undefined }; },
		});

		await harnessTool.execute('call-1', { text: 'x' }, () => {}, undefined, INVOCATION, CTX);
		expect(received).toBeUndefined();
	});

	it('工具抛错照原样冒泡（不吞、不改写，由 harness 记成 isError）', async () => {
		const harnessTool = toHarnessTool({
			name: 'Boom', label: 'Boom', description: '总是失败', parameters: echoSchema,
			execute: async () => { throw new Error('boom: no such file'); },
		});

		await expect(harnessTool.execute('call-1', { text: 'x' }, () => {}, undefined, INVOCATION, CTX)).rejects.toThrow(
			'boom: no such file',
		);
	});
});

describe('toHarnessTool：真 harness 端到端', () => {
	it('模型调用适配后的工具 → 工具真被执行，结果回到对话里', async () => {
		const fs = createBrowserFileSystem({ dbName: 'extensions-harness-tool', memory: true });
		const repo = new JsonlSessionRepo({ fileSystem: fs, sessionsRoot: '/sessions' });
		const session = await repo.create({ id: 's1', cwd: '/' }, CTX);

		const faux = fauxProvider({ models: [{ id: 'faux', contextWindow: 128_000, maxTokens: 512 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall('Echo', { text: 'ping' })], { stopReason: 'toolUse' }),
			fauxAssistantMessage('收到 echo:ping'),
		]);

		const executed: string[] = [];
		const echo = toHarnessTool({
			name: 'Echo', label: 'Echo', description: '回显 text 参数', parameters: echoSchema,
			execute: async (_toolCallId, input) => {
				executed.push(input.text);
				return { content: [{ type: 'text', text: `echo:${input.text}` }], details: undefined };
			},
		});

		const { harness } = await AgentHarness.create(
			{ session, models, model: faux.getModel(), tools: [echo], systemPrompt: 'sys' },
			CTX,
		);
		const lane = await harness.lane('main', { createAt: null }, CTX);
		const run = await lane.prompt('回显 ping', undefined, CTX);

		expect(run.ok, run.ok ? undefined : JSON.stringify(run.error)).toBe(true);
		if (!run.ok) return;
		expect(run.value.status).toBe('completed');
		expect(executed).toEqual(['ping']);
		const entries = await session.findEntries({ order: 'asc' }, CTX);
		expect(JSON.stringify(entries)).toContain('echo:ping'); // 工具结果进了 transcript（模型下一轮也看得到）
		expect(await harness.getTools(CTX)).toHaveLength(1);

		await harness.close(CTX);
		await fs.cleanup(CTX);
	});
});

describe('toHarnessTool：端到端取消（S5 spec §7.3）', () => {
	it('父 run 取消 → 工具内的 signal 被 abort（否则适配器只是形状转换）', async () => {
		const fs = createBrowserFileSystem({ dbName: 'extensions-harness-tool-abort', memory: true });
		const repo = new JsonlSessionRepo({ fileSystem: fs, sessionsRoot: '/sessions' });
		const session = await repo.create({ id: 's-abort', cwd: '/' }, CTX);

		const faux = fauxProvider({ models: [{ id: 'faux', contextWindow: 128_000, maxTokens: 512 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage([fauxToolCall('Wait', {})], { stopReason: 'toolUse' })]);

		let captured: AbortSignal | undefined;
		let entered!: () => void;
		const enteredP = new Promise<void>((resolve) => { entered = resolve; });
		const wait = toHarnessTool({
			name: 'Wait',
			label: 'Wait',
			description: '阻塞直到父 run 取消',
			parameters: Type.Object({}),
			execute: async (_toolCallId, _input, signal) => {
				captured = signal;
				entered();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) { resolve(); return; }
					signal?.addEventListener('abort', () => { resolve(); }, { once: true });
				});
				throw new Error('aborted by parent run');
			},
		});

		const { harness } = await AgentHarness.create(
			{ session, models, model: faux.getModel(), tools: [wait], systemPrompt: 'sys' },
			CTX,
		);
		const lane = await harness.lane('main', { createAt: null }, CTX);
		const prompting = lane.prompt('等一等', undefined, CTX);
		await enteredP;                     // 工具确实进入了执行
		// 注意：取消必须走 harness 原生 `lane.abort(CTX)`——把应用侧 signal 经 `withAbortSignal`
		// 塞进 prompt 的 context **不会**穿透到工具内的 `context.abortSignal`（实测：captured.aborted 仍为 false）。
		await lane.abort(CTX);
		await prompting.catch(() => {});    // 取消向上传播（run 以 aborted/错误收场）
		expect(captured).toBeDefined();
		expect(captured?.aborted).toBe(true);
	});
});
