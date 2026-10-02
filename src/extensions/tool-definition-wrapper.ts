// src/extensions/tool-definition-wrapper.ts —— P3 Task 19：`ToolDefinition` → `AgentTool` 适配（**内部件**）。
//
// 改名理由：旧名 `harness-tool.ts` 里的 `harness` 落点已随注入模型重建消失（spec C11/D4）；
// 新名与上游 `core/tools/tool-definition-wrapper.ts` 一致，适配方向也与上游对偶。
//
// 为什么仍然需要适配、且不能靠结构相容蒙混过去：pi 的 `ToolDefinition.execute` 是**五参**
// （末位多一个 `ctx: ExtensionContext`），core 的 `AgentTool.execute` 是**四参**
// `(toolCallId, params, signal?, onUpdate?)`（pi-agent-core 0.99.1；1.0.0 才给 core 侧加第五参，
// P6 升版本时再对齐）。适配器补的就是这第五参：
//   ctx      ← `ctxFactory(toolCallId, signal)`，**按本次调用**构造（父 run 取消时才传得进去）
//   signal / onUpdate 原样透传
// 异常不吞：工具抛错照原样冒泡，由 core 记成 `isError` 的工具结果。
//
// 与上游的三处有意差异：
//   ① `ctxFactory` **必填**（上游可选）：上游的 core execute 自带 `ctx`，`ctxFactory` 只是兜底；
//      本仓的 core execute 没有 ctx 这一路，兜底就是唯一路径 —— 可选会让 `ctx` 变成 `undefined`，
//      而 `ToolDefinition.execute` 的第五参是必填的。
//   ② 不照抄上游 `ctx ?? ctxFactory?.(...)` 里的 `ctx` 分支：在 0.99.1 的 execute 签名下它是死代码
//      （AGENTS §2 不放投机分支）。P6 升到 1.0.0 后 core 会自己传 ctx，那时再把这条补回来。
//   ③ 只交付 `wrapToolDefinition`（单个）。上游另有 `wrapToolDefinitions`（复数）与
//      `createToolDefinitionFromAgentTool`（反向），本仓无消费者，不造（AGENTS §2）。
//      `ToolDefinition` 上游有、本仓刻意不声明的字段（`outputSchema` / `constrainedSampling` /
//      `prepareArguments` / `executionMode` / `renderCall` / `renderResult`，见 tool.ts 与 S6 §3.3 裁决）
//      因此无从透传；`AgentTool` 侧它们都是可选项，缺省即可。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from './context';
import type { ToolDefinition } from './tool';

/** 为一次工具调用构造上下文（上游 `ToolContextFactory` 的浏览器子集：只回 `ExtensionContext`）。 */
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionContext;

/** 把一份扩展工具声明适配成 core 直接可注册的工具。 */
export function wrapToolDefinition<TParams extends ToolDefinition['parameters'], TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
	ctxFactory: ToolContextFactory,
): AgentTool<TParams, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctxFactory(toolCallId, signal)),
	};
}
