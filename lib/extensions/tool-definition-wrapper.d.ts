import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from './context.js';
import type { ToolDefinition } from './tool.js';
/** 为一次工具调用构造上下文（上游 `ToolContextFactory` 的浏览器子集：只回 `ExtensionContext`）。 */
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionContext;
/** 把一份扩展工具声明适配成 core 直接可注册的工具。 */
export declare function wrapToolDefinition<TParams extends ToolDefinition['parameters'], TDetails>(definition: ToolDefinition<TParams, TDetails>, ctxFactory: ToolContextFactory): AgentTool<TParams, TDetails>;
