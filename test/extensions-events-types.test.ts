// test/extensions-events-types.test.ts —— P3 Task 19：25 条「支持」事件的载荷类型**与上游逐字同形**。
//
// 为什么用 tsc 当判卷器（而不是人眼比对，也不是运行时测试）：`events.ts` 全部是类型，vitest 跑不出东西；
// 而本仓已有的做法（P2b/P2c「测试直接 import 上游 `createXToolDefinition` 逐字比对」）在这里可以做得更狠——
// **直接 import 上游的 `.d.ts`**（相对路径绕开 pi-coding-agent 的 `exports` 限制，devDep 只在测试侧用），
// 然后双向 assignability 断言。任何转写漂移（少字段、多字段、可选性变化、联合分支变化）都在 tsc 上红。
//
// 用法：`same<我们, 上游>(true)` —— 不一致时形参类型退化成 `never`，tsc 在**该行**报错并带上两个类型名，
// 一行一个类型，定位不需要额外工具。
//
// 上游的闭包类型（会话条目 / 压缩 / 提示词选项）由 `types.d.ts` **引用**而非 re-export，
// 所以那半边对着各自的定义文件比对；事件本身与 handler 返回值对着 `extensions/types`。
//
// 纪律：本文件只做形状对照，不做行为断言（行为在 `extensions-events.test.ts` 逐路由触发）。
import { describe, it, expect } from 'vitest';
import * as events from '../src/extensions/events';
import type * as Upstream from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types';
import type * as UpstreamSession from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager';
import type * as UpstreamCompaction from '../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction';
import type * as UpstreamCompactionUtils from '../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils';
import type * as UpstreamPrompt from '../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt';
import type * as UpstreamMessages from '../node_modules/@earendil-works/pi-coding-agent/dist/core/messages';
import type * as Ours from '../src/extensions/events';

/** 严格相等（双向可赋值）；`any` 泄漏会让两侧同时退化成 `any` 而恒真，故加 `0 extends 1` 兜一道。 */
type Eq<A, B> = 0 extends 1 & A ? never
	: 0 extends 1 & B ? never
	: [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function same<A, B>(_: Eq<A, B> extends true ? true : never): void {}

// ———— 25 条「支持」事件的载荷 ————
describe('支持事件的载荷与上游逐字同形', () => {
	it('会话生命周期四事件', () => {
		same<Ours.SessionStartEvent, Upstream.SessionStartEvent>(true);
		same<Ours.SessionShutdownEvent, Upstream.SessionShutdownEvent>(true);
		same<Ours.SessionBeforeCompactEvent, Upstream.SessionBeforeCompactEvent>(true);
		same<Ours.SessionCompactEvent, Upstream.SessionCompactEvent>(true);
		expect(events).toBeTypeOf('object');
	});

	it('树导航与回合边界', () => {
		same<Ours.SessionBeforeTreeEvent, Upstream.SessionBeforeTreeEvent>(true);
		same<Ours.SessionTreeEvent, Upstream.SessionTreeEvent>(true);
		same<Ours.TurnStartEvent, Upstream.TurnStartEvent>(true);
		same<Ours.TurnEndEvent, Upstream.TurnEndEvent>(true);
	});

	it('agent 循环与 provider 四事件', () => {
		same<Ours.AgentStartEvent, Upstream.AgentStartEvent>(true);
		same<Ours.AgentEndEvent, Upstream.AgentEndEvent>(true);
		same<Ours.ContextEvent, Upstream.ContextEvent>(true);
		same<Ours.BeforeAgentStartEvent, Upstream.BeforeAgentStartEvent>(true);
		same<Ours.BeforeProviderRequestEvent, Upstream.BeforeProviderRequestEvent>(true);
		same<Ours.BeforeProviderHeadersEvent, Upstream.BeforeProviderHeadersEvent>(true);
		same<Ours.AfterProviderResponseEvent, Upstream.AfterProviderResponseEvent>(true);
	});

	it('消息与工具执行三事件', () => {
		same<Ours.MessageStartEvent, Upstream.MessageStartEvent>(true);
		same<Ours.MessageUpdateEvent, Upstream.MessageUpdateEvent>(true);
		same<Ours.MessageEndEvent, Upstream.MessageEndEvent>(true);
		same<Ours.ToolExecutionStartEvent, Upstream.ToolExecutionStartEvent>(true);
		same<Ours.ToolExecutionUpdateEvent, Upstream.ToolExecutionUpdateEvent>(true);
		same<Ours.ToolExecutionEndEvent, Upstream.ToolExecutionEndEvent>(true);
	});

	it('配置变更两事件', () => {
		same<Ours.ModelSelectEvent, Upstream.ModelSelectEvent>(true);
		same<Ours.ThinkingLevelSelectEvent, Upstream.ThinkingLevelSelectEvent>(true);
	});

	it('tool_call / tool_result 的 9 变体联合', () => {
		same<Ours.ToolCallEvent, Upstream.ToolCallEvent>(true);
		same<Ours.ToolResultEvent, Upstream.ToolResultEvent>(true);
		same<Ours.BashToolCallEvent, Upstream.BashToolCallEvent>(true);
		same<Ours.CustomToolCallEvent, Upstream.CustomToolCallEvent>(true);
		same<Ours.BashToolResultEvent, Upstream.BashToolResultEvent>(true);
		same<Ours.WriteToolResultEvent, Upstream.WriteToolResultEvent>(true);
		same<Ours.CustomToolResultEvent, Upstream.CustomToolResultEvent>(true);
	});

	it('handler 返回值类型', () => {
		same<Ours.ContextEventResult, Upstream.ContextEventResult>(true);
		same<Ours.TurnEndEventResult, Upstream.TurnEndEventResult>(true);
		same<Ours.BeforeProviderRequestEventResult, Upstream.BeforeProviderRequestEventResult>(true);
		same<Ours.ToolCallEventResult, Upstream.ToolCallEventResult>(true);
		same<Ours.ToolResultEventResult, Upstream.ToolResultEventResult>(true);
		same<Ours.MessageEndEventResult, Upstream.MessageEndEventResult>(true);
		same<Ours.BeforeAgentStartEventResult, Upstream.BeforeAgentStartEventResult>(true);
		same<Ours.SessionBeforeCompactResult, Upstream.SessionBeforeCompactResult>(true);
		same<Ours.SessionBeforeTreeResult, Upstream.SessionBeforeTreeResult>(true);
	});
});

// ———— CLI 仓内部类型的转写（25 条载荷的可达闭包）———
describe('CLI 仓闭包类型与上游逐字同形', () => {
	it('会话条目族', () => {
		same<Ours.SessionEntryBase, UpstreamSession.SessionEntryBase>(true);
		same<Ours.SessionMessageEntry, UpstreamSession.SessionMessageEntry>(true);
		same<Ours.ThinkingLevelChangeEntry, UpstreamSession.ThinkingLevelChangeEntry>(true);
		same<Ours.ModelChangeEntry, UpstreamSession.ModelChangeEntry>(true);
		same<Ours.UsageEntry, UpstreamSession.UsageEntry>(true);
		same<Ours.CompactionEntry, UpstreamSession.CompactionEntry>(true);
		same<Ours.BranchSummaryEntry, UpstreamSession.BranchSummaryEntry>(true);
		same<Ours.CustomEntry, UpstreamSession.CustomEntry>(true);
		same<Ours.LabelEntry, UpstreamSession.LabelEntry>(true);
		same<Ours.SessionInfoEntry, UpstreamSession.SessionInfoEntry>(true);
		same<Ours.CustomMessageEntry, UpstreamSession.CustomMessageEntry>(true);
		same<Ours.ContextEditEntry, UpstreamSession.ContextEditEntry>(true);
		same<Ours.SessionEntry, UpstreamSession.SessionEntry>(true);
		same<Ours.ProjectedSessionEntry, UpstreamSession.ProjectedSessionEntry>(true);
	});

	it('压缩与提示词选项', () => {
		same<Ours.CustomMessage, UpstreamMessages.CustomMessage>(true);
		same<Ours.CompactionResult, UpstreamCompaction.CompactionResult>(true);
		same<Ours.CompactionSettings, UpstreamCompaction.CompactionSettings>(true);
		same<Ours.CompactionPreparation, UpstreamCompaction.CompactionPreparation>(true);
		same<Ours.FileOperations, UpstreamCompactionUtils.FileOperations>(true);
		same<Ours.BuildSystemPromptOptions, UpstreamPrompt.BuildSystemPromptOptions>(true);
		same<Ours.NormalizedBuildSystemPromptOptions, UpstreamPrompt.NormalizedBuildSystemPromptOptions>(true);
	});

	it('回合边界草稿族', () => {
		same<Ours.TreePreparation, Upstream.TreePreparation>(true);
		same<Ours.AgentActivityOutcome, Upstream.AgentActivityOutcome>(true);
		same<Ours.CustomEntryDraft, Upstream.CustomEntryDraft>(true);
		same<Ours.CustomMessageEntryDraft, Upstream.CustomMessageEntryDraft>(true);
		same<Ours.ContextEditEntryDraft, Upstream.ContextEditEntryDraft>(true);
		same<Ours.CompactionEntryDraft, Upstream.CompactionEntryDraft>(true);
		same<Ours.SessionBoundaryDraft, Upstream.SessionBoundaryDraft>(true);
		same<Ours.BoundaryContextPreview, Upstream.BoundaryContextPreview>(true);
		same<Ours.BoundaryState, Upstream.BoundaryState>(true);
		same<Ours.BoundaryResult, Upstream.BoundaryResult>(true);
	});
});
