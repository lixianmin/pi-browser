// src/extensions/harness-tool.ts —— S6 spec §3.3：`ToolDefinition` → `AgentHarnessTool` 适配（**内部件**）。
//
// 为什么需要适配、且不能靠结构相容蒙混过去：harness 的第三参是 `onUpdate`（不是 AbortSignal），
// 后面还多 toolContext / invocation / context；而 pi 的 `ToolDefinition.execute` 是
// `(toolCallId, params, signal, onUpdate, ctx)`——两边**参数顺序与个数都不同**。
//   signal   ← `context.abortSignal`（harness 用 `withAbortSignal` 把父 run 的取消放进 context）
//   onUpdate → 原样透传
//   ctx      ← 由宿主按本次调用信号构造的 `ExtensionContext`
// 异常不吞：工具抛错照原样冒泡，由 harness 记成 `isError` 的工具结果。
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from './context';
import type { ToolDefinition } from './tool';

/** 把一份扩展工具声明适配成 harness 直接可注册的工具。 */
export function toHarnessTool<TParameters extends ToolDefinition['parameters'], TDetails>(
	definition: ToolDefinition<TParameters, TDetails>,
	contextFor: (signal: AbortSignal | undefined) => ExtensionContext,
): AgentHarnessTool<undefined, TParameters, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, onUpdate, _toolContext, _invocation, context) =>
			definition.execute(
				toolCallId,
				params,
				context?.abortSignal,
				onUpdate,
				contextFor(context?.abortSignal),
			),
	};
}
