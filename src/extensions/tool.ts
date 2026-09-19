// src/extensions/tool.ts —— S6 spec §3.3：`ToolDefinition`（pi 同名同形）+ 注册期校验。
//
// 与 S5 的差别：
//   · `label` 必填（pi 的形状；S5 的「缺省归一为 name」不再有——容忍度不同会让两边的扩展不能互换）；
//   · `execute` 是**五参**（多一个 `ctx: ExtensionContext`，pi 的原样形状）；
//   · 支持 `promptSnippet` / `promptGuidelines`（上游字段，进 system prompt 的对应段）。
// **刻意不声明**浏览器做不到的字段（`renderCall` / `renderResult` / `renderShell` / `constrainedSampling` /
// `prepareArguments` / `executionMode`）：声明了却不生效比不声明更糟（S5 的「静默失效最糟」口径）。
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';
import type { ExtensionContext } from './context';

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
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<TDetails>>;
}

/**
 * 注册期校验：声明期能查清的事一律响亮抛错（缺 `description` 模型就选不准工具、缺 `parameters`
 * 上游没法校验入参、缺 `execute` 工具就是空的、缺 `label` 与上游形状不符）。
 * 错误消息带工具名——静默失效比报错更糟。
 */
export function validateToolDefinition(def: ToolDefinition): void {
	const name = typeof def?.name === 'string' ? def.name.trim() : '';
	const where = name === '' ? '（工具名缺失）' : `"${name}"`;
	const bad = (why: string): never => {
		throw new Error(`registerTool${where}：${why}`);
	};
	if (name === '') bad('`name` 不能为空');
	if (typeof def.label !== 'string' || def.label.trim() === '') bad('`label` 不能为空（pi 必填，不做缺省归一）');
	if (typeof def.description !== 'string' || def.description.trim() === '') bad('`description` 不能为空（模型靠它选工具）');
	if (def.parameters === undefined || def.parameters === null) bad('`parameters` 缺失（typebox schema）');
	if (typeof def.execute !== 'function') bad('`execute` 必须是函数');
}
