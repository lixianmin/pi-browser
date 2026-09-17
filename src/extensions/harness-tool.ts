// src/extensions/harness-tool.ts —— S5 spec §3.1（Task 2b）：`AgentTool` → `AgentHarnessTool` 适配。
//
// 两侧 execute 签名不同，且**不能靠结构相容蒙混过去**：harness 的第三参是 onUpdate（不是 AbortSignal），
// 后面还多 toolContext/invocation/context；直接塞 `AgentTool` 进 `AgentHarness.tools`，onUpdate 会被当成
// signal（编译期也过不去）。所以这里做显式映射：
//   signal   ← `context.abortSignal`（harness 用 `withAbortSignal` 把父 run 的取消放进 context）
//   onUpdate → 原样透传（harness 的进度回调 ↔ 工具的 onUpdate）
//   toolContext / invocation → 扩展工具面拿不到（同 pi 的扩展工具面：只有 toolCallId/input/signal/onUpdate）
// 异常不吞：工具抛错照原样冒泡，由 harness 记成 `isError` 的工具结果。
import type { AgentHarnessTool, AgentTool } from '@earendil-works/pi-agent-core';

/** 把一份内置/扩展工具（`AgentTool` 形状）适配成 harness 直接可注册的工具 */
export function toHarnessTool<TParameters extends AgentTool['parameters'], TDetails>(
	tool: AgentTool<TParameters, TDetails>,
): AgentHarnessTool<undefined, TParameters, TDetails> {
	return {
		...tool,
		execute: (toolCallId, params, onUpdate, _toolContext, _invocation, context) =>
			tool.execute(toolCallId, params, context.abortSignal, onUpdate),
	};
}
