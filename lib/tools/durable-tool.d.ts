import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { TSchema } from '@earendil-works/pi-ai';
/**
 * 把一份本仓工具（`AgentTool`，七工厂的产物）适配成 pi-durable 编排层可注册的 `ToolRegistration`。
 *
 * 依赖注入（fs / operations）在**构造期**就已定型（见文件头「为什么 fs 在构造期捕获」）：
 * 适配只做 execute 的翻译与结果的投影。
 *
 * @param tool 本仓工具；`execute` 的 `toolCallId` 取 `api.callId`（durable 侧逐次调用唯一的调用标识）
 * @returns 可装进 pi-durable `Registry` 的工具注册件
 */
export declare function asDurableTool<TParameters extends TSchema>(tool: AgentTool<TParameters, any>): ToolRegistration<TParameters, any>;
