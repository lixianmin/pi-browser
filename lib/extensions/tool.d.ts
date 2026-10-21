import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';
import type { ExtensionContext } from './context.js';
/**
 * 扩展工具声明（pi `ToolDefinition` 的子集：只保留浏览器能兑现的字段）。
 * `TParams` 用具体 schema 时 `params` 会推断成 `Static<TParams>`；同 S5 的教训，不能用 `Static<TSchema>`
 * 兜底（会退化成 `unknown`，具体 schema 的工具赋不进来）。
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
    /** 工具名（模型可见） */
    name: string;
    /** UI 展示名（pi 必填） */
    label: string;
    /** 给模型看的描述 */
    description: string;
    /** system prompt「可用工具」段的单行摘要；缺省则不出现（pi 语义） */
    promptSnippet?: string;
    /** 工具激活时追加进 system prompt「Guidelines」段的条目（pi 语义） */
    promptGuidelines?: string[];
    /** 入参 schema（typebox） */
    parameters: TParams;
    execute: (toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<TDetails>>;
}
/**
 * 上游 `defineTool` 同名同形：保留参数推断。
 * 为什么需要：把工具赋给变量或放进数组时，上下文类型会把 `TParams` 拓宽回默认值（`params` 变成 `unknown`），
 * 调用方就得手写泛型——pi 用这个辅助函数顶住推断，我们照抄。
 */
export declare function defineTool<TParams extends TSchema, TDetails = unknown>(definition: ToolDefinition<TParams, TDetails>): ToolDefinition<TParams, TDetails>;
/**
 * 注册期校验：声明期能查清的事一律响亮抛错（缺 `description` 模型就选不准工具、缺 `parameters`
 * 上游没法校验入参、缺 `execute` 工具就是空的、缺 `label` 与上游形状不符）。
 * 错误消息带工具名——静默失效比报错更糟。
 */
export declare function validateToolDefinition(def: ToolDefinition): void;
