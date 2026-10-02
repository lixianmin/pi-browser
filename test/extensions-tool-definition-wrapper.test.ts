// test/extensions-tool-definition-wrapper.test.ts —— P3 Task 19：`ToolDefinition` → `AgentTool` 适配器契约。
//
// 适配的必要性（文件名也换了：旧名里的 `harness` 已无对应物）：pi 的
// `ToolDefinition.execute` 是**五参**（末位多一个 `ctx: ExtensionContext`），而 core 的
// `AgentTool.execute` 是**四参**（`(toolCallId, params, signal?, onUpdate?)`，见 P2b/P2c 的 F6 裁决：
// 本仓锁在 pi-agent-core 0.99.1，1.0.0 才给 core 的 execute 加第五参）。适配器补的就是这第五参：
//   ctx ← `ctxFactory(toolCallId, signal)`（按**本次调用**的信号构造，所以父 run 取消能穿透到扩展工具）
//   signal / onUpdate 原样透传
// 工具抛错照原样冒泡（由 core 记成 isError 的工具结果），适配器不许吞。
//
// 与上游 `core/tools/tool-definition-wrapper.js` 的差异（有意，理由见各处注释）：
//   · 上游 `ctxFactory` 可选（它的 core execute 已自带 ctx）；本仓 core execute 没有 ctx，故**必填**——
//     否则 `ctx` 只能是 `undefined`，而 `ToolDefinition.execute` 的第五参是必填的。
//   · 上游那句 `ctx ?? ctxFactory?.(...)` 里的 `ctx` 分支是 1.0.0 的 core 形状，本仓（P6 升版本前）恒为
//     `undefined`，不照抄这条死分支。
import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { wrapToolDefinition } from '../src/extensions/tool-definition-wrapper';
import type { ExtensionContext } from '../src/extensions/context';
import type { ToolDefinition } from '../src/extensions/tool';

const ctx: ExtensionContext = {
	cwd: '/w',
	model: undefined,
	signal: undefined,
	abort: vi.fn(),
	compact: vi.fn(),
};

const definition = (execute: ToolDefinition['execute']): ToolDefinition => ({
	name: 'echo',
	label: 'Echo',
	description: '回显',
	parameters: Type.Object({ text: Type.String() }),
	execute,
});

/** core 的 execute 形状：四参（第三参是 signal，不是旧 harness 的 onUpdate）。 */
const callCore = (tool: unknown, ...args: unknown[]): Promise<unknown> =>
	(tool as { execute: (...a: unknown[]) => Promise<unknown> }).execute(...args);

describe('wrapToolDefinition（适配器）', () => {
	it('四参 core execute 补成五参：ctx 由 ctxFactory 按本次调用信号构造，元数据带过', async () => {
		const seen: unknown[][] = [];
		const schema = Type.Object({ text: Type.String() });
		const def = definition((async (...args: unknown[]) => {
			seen.push(args);
			return { content: [], details: {} };
		}) as never);
		def.parameters = schema;
		const tool = wrapToolDefinition(def, (toolCallId, signal) => ({ ...ctx, signal }));

		expect(tool.name).toBe('echo');
		expect(tool.label).toBe('Echo');
		expect(tool.description).toBe('回显');
		expect(tool.parameters).toBe(schema);

		const ac = new AbortController();
		const onUpdate = vi.fn();
		await callCore(tool, 'c1', { text: 'hi' }, ac.signal, onUpdate);
		expect(seen[0]![0]).toBe('c1');
		expect(seen[0]![1]).toEqual({ text: 'hi' });
		expect(seen[0]![2]).toBe(ac.signal);
		expect(seen[0]![3]).toBe(onUpdate);
		expect(seen[0]![4]).toMatchObject({ cwd: '/w', signal: ac.signal });
	});

	it('ctxFactory 收到的 signal 就是本次调用的 signal（U13：取消必须按调用穿透）', async () => {
		const seen: Array<[string, AbortSignal | undefined]> = [];
		const tool = wrapToolDefinition(definition((async () => ({ content: [], details: {} })) as never),
			(toolCallId, signal) => {
				seen.push([toolCallId, signal]);
				return ctx;
			});

		const ac = new AbortController();
		await callCore(tool, 'c9', {}, ac.signal, undefined);
		expect(seen).toEqual([['c9', ac.signal]]);
	});

	it('core 没给 signal 时不伪造 AbortSignal（signal 与 ctx.signal 都是 undefined）', async () => {
		const seen: unknown[][] = [];
		const tool = wrapToolDefinition(definition((async (...args: unknown[]) => {
			seen.push(args);
			return { content: [], details: {} };
		}) as never), (_toolCallId, signal) => ({ ...ctx, signal }));

		await callCore(tool, 'c1', {}, undefined, undefined);
		expect(seen[0]![2]).toBeUndefined();
		expect((seen[0]![4] as { signal?: AbortSignal }).signal).toBeUndefined();
	});

	it('工具抛错照原样冒泡（不吞、不改写）', async () => {
		const tool = wrapToolDefinition(
			definition((async () => { throw new Error('boom'); }) as never),
			() => ctx,
		);
		await expect(callCore(tool, 'c1', {}, undefined, undefined)).rejects.toThrow('boom');
	});
});
