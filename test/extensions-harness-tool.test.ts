// test/extensions-harness-tool.test.ts —— S6 T3：`ToolDefinition` → `AgentHarnessTool` 适配器契约。
//
// 关键不是"形状转换"，而是三件容易静默出错的事：
//   ① signal 的来源（harness 的 `context.abortSignal`，不是第三参 onUpdate）；
//   ② ExtensionContext 必须按**本次调用**的信号构造（父 run 取消时的停止语义靠它）；
//   ③ 工具抛错照原样冒泡（由 harness 记成 isError），适配器不许吞。
import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { toHarnessTool } from '../src/extensions/harness-tool';
import { createExtensionContext } from '../src/extensions/context';
import type { ToolDefinition } from '../src/extensions/tool';

const ctxFor = (signal?: AbortSignal) => createExtensionContext({
	cwd: '/w',
	lane: { abort: vi.fn(async () => ({})) } as never,
	context: {} as never,
	signal,
});

const definition = (execute: ToolDefinition['execute']): ToolDefinition => ({
	name: 'echo',
	label: 'Echo',
	description: '回显',
	parameters: Type.Object({ text: Type.String() }),
	execute,
});

describe('toHarnessTool（适配器）', () => {
	it('六参 execute 压成五参：signal 取 context.abortSignal，onUpdate 原样透传，元数据带过', async () => {
		const seen: unknown[][] = [];
		const exec = vi.fn(async (toolCallId, params, signal, onUpdate, ctx) => {
			seen.push([toolCallId, params, signal, onUpdate, ctx]);
			return { content: [], details: {} };
		});
		const tool = toHarnessTool(definition(exec as never), ctxFor);
		expect(tool.name).toBe('echo');
		expect(tool.label).toBe('Echo');

		const ac = new AbortController();
		const onUpdate = vi.fn();
		await (tool.execute as never as (...a: unknown[]) => Promise<unknown>)('c1', { text: 'hi' }, onUpdate, undefined, undefined, { abortSignal: ac.signal });
		expect(seen[0]![0]).toBe('c1');
		expect(seen[0]![1]).toEqual({ text: 'hi' });
		expect(seen[0]![2]).toBe(ac.signal);
		expect(seen[0]![3]).toBe(onUpdate);
		expect((seen[0]![4] as { cwd: string; signal?: AbortSignal }).cwd).toBe('/w');
		expect((seen[0]![4] as { signal?: AbortSignal }).signal).toBe(ac.signal);
	});

	it('context 上没有信号时 signal/ctx.signal 都是 undefined（不伪造 AbortSignal）', async () => {
		const seen: unknown[][] = [];
		const tool = toHarnessTool(definition((async (...args: unknown[]) => { seen.push(args); return { content: [], details: {} }; }) as never), ctxFor);
		await (tool.execute as never as (...a: unknown[]) => Promise<unknown>)('c1', {}, undefined, undefined, undefined, {});
		expect(seen[0]![2]).toBeUndefined();
		expect((seen[0]![4] as { signal?: AbortSignal }).signal).toBeUndefined();
	});

	it('工具抛错照原样冒泡（不吞、不改写）', async () => {
		const tool = toHarnessTool(definition((async () => { throw new Error('boom'); }) as never), ctxFor);
		await expect((tool.execute as never as (...a: unknown[]) => Promise<unknown>)('c1', {}, undefined, undefined, undefined, {})).rejects.toThrow('boom');
	});
});
