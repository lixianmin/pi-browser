// src/extensions/contract.ts —— S6 spec §2/§3.2/§3.4：上游名字的**唯一真源表**。
//
// 出处：@earendil-works/pi-coding-agent@0.85.1 `dist/core/extensions/types.d.ts`
//   ExtensionAPI（`on` + 25 个非 on 成员，共 26）、`ExtensionAPI.on` 的 36 个事件名、
//   ExtensionContext 17 个成员、ToolDefinition 字段（见 tool.ts）。
// 纪律（S6 spec §3.1/§3.2）：
//   ① 对外面只允许出现下表中的名字，**不新增自造名**（S5 的 `defineExtension`/`composeToolset` 已删）；
//   ② 标 UNSUPPORTED 的名字**不得**在本仓另有实现（测试断言公开面上没有同名替代物）；
//   ③ 上游升级时：重抄三张名单（本文件承担对照基线），`test/extensions-contract.test.ts` 里另有一份
//      硬编码副本——两份都被改动才可能同时绿，这是刻意的双确认（防单点笔误漂移）。
//
// 「支持」判定规则（spec §3.4）：有直接对应物且我们现在有用例 → 支持；
// 有对应物但无用例 → 先声明不支持（YAGNI，保留原名不造替代名）；无对应物 → 不支持。

/** 上游 ExtensionAPI 的成员名（含 `on`；共 26）。 */
export const EXTENSION_API_MEMBERS = [
	'on',
	'registerTool',
	'registerCommand',
	'registerShortcut',
	'registerFlag',
	'getFlag',
	'registerMessageRenderer',
	'registerMarkdownTransformer',
	'registerEntryRenderer',
	'sendMessage',
	'sendUserMessage',
	'appendEntry',
	'setSessionName',
	'getSessionName',
	'setLabel',
	'exec',
	'getActiveTools',
	'getAllTools',
	'setActiveTools',
	'getCommands',
	'setModel',
	'getThinkingLevel',
	'setThinkingLevel',
	'registerProvider',
	'unregisterProvider',
	'events',
] as const;

/** 上游 ExtensionAPI.on 的事件名（36 个）。 */
export const EXTENSION_EVENTS = [
	'project_trust',
	'resources_discover',
	'session_start',
	'session_info_changed',
	'session_before_switch',
	'session_before_fork',
	'session_before_compact',
	'session_compact',
	'session_compact_failed',
	'session_shutdown',
	'session_before_tree',
	'session_tree',
	'context',
	'input',
	'before_provider_request',
	'before_provider_headers',
	'after_provider_response',
	'before_agent_start',
	'agent_start',
	'agent_end',
	'agent_settled',
	'ui_prompt_start',
	'ui_prompt_end',
	'turn_start',
	'turn_end',
	'message_start',
	'message_update',
	'message_end',
	'tool_execution_start',
	'tool_execution_update',
	'tool_execution_end',
	'model_select',
	'thinking_level_select',
	'tool_call',
	'tool_result',
	'user_bash',
] as const;

/** 上游 ExtensionContext 的成员（17 个）。 */
export const EXTENSION_CONTEXT_MEMBERS = [
	'ui',
	'mode',
	'hasUI',
	'cwd',
	'sessionManager',
	'modelRegistry',
	'model',
	'scopedModels',
	'isIdle',
	'isProjectTrusted',
	'signal',
	'abort',
	'hasPendingMessages',
	'shutdown',
	'getContextUsage',
	'compact',
	'getSystemPrompt',
] as const;

/** 支持的 API 成员（落点见 spec §3.2 表）。 */
export const SUPPORTED_API_MEMBERS = [
	'on',
	'registerTool',
	'getActiveTools',
	'getAllTools',
	'setActiveTools',
	'registerProvider',
	'unregisterProvider',
	'events',
	'appendEntry',
	'sendMessage',
	'sendUserMessage',
	'setSessionName',
	'getSessionName',
	'setLabel',
	'setModel',
	'getThinkingLevel',
	'setThinkingLevel',
	'exec',
] as const;

/** 不支持的 API 成员：浏览器无 slash 命令面 / 无 TUI 键位与 CLI flag / 无 TUI 渲染器。 */
export const UNSUPPORTED_API_MEMBERS = [
	'registerCommand',
	'getCommands',
	'registerShortcut',
	'registerFlag',
	'getFlag',
	'registerMessageRenderer',
	'registerMarkdownTransformer',
	'registerEntryRenderer',
] as const;

/** 支持的 Context 成员。 */
export const SUPPORTED_CONTEXT_MEMBERS = [
	'cwd',
	'sessionManager',
	'modelRegistry',
	'model',
	'scopedModels',
	'isIdle',
	'signal',
	'abort',
	'hasPendingMessages',
	'getContextUsage',
	'compact',
	'getSystemPrompt',
] as const;

/** 不支持的 Context 成员：`ui`/`mode`/`hasUI` 是 TUI 概念；`isProjectTrusted` 无信任门；`shutdown` 无宿主进程。 */
export const UNSUPPORTED_CONTEXT_MEMBERS = [
	'ui',
	'mode',
	'hasUI',
	'isProjectTrusted',
	'shutdown',
] as const;

/**
 * pi 事件名 → 落点（spec §3.4）。值 = 人类可读的落点说明；实现期由 `api.ts` 的映射表消费。
 *
 * 四项「待核实」的裁决（S6 spec §3.4 要求 T1 给出结论，不许悬空）：
 *   · `before_provider_headers` → 支持：`hooks.on('before_request')` 返回 streamOptions patch，
 *     其 `headers` 支持逐键增删（pi-agent-core types.d.ts:94 / 106-108 实证）。
 *   · `agent_start` → 支持：`events.on('run_start')`。
 *   · `input` → **不支持**：pi-agent-core 没有能改写用户输入的钩子（`before_run` 只能追加 messages，
 *     改不了 input 文本 / 来源 / 投递方式）。
 *   · `agent_settled` → **不支持**：无 idle/settled 事件；`run_end` 与 `agent_end` 同源，区分不出 settled 语义。
 */
export const SUPPORTED_EVENTS: Readonly<Record<string, string>> = {
	context: "hooks.on('transform_context')",
	before_agent_start: "hooks.on('before_run')",
	agent_start: "events.on('run_start')",
	agent_end: "events.on('run_end')",
	turn_start: "events.on('turn_start')",
	turn_end: "events.on('turn_end')",
	message_start: "events.on('message_start')",
	message_update: "events.on('message_update')",
	message_end: "events.on('message_end')",
	tool_execution_start: "events.on('tool_start')",
	tool_execution_update: "events.on('tool_update')",
	tool_execution_end: "events.on('tool_end')",
	tool_call: "hooks.on('before_tool')",
	tool_result: "hooks.on('after_tool')",
	session_before_compact: "hooks.on('before_compaction')",
	session_compact: "events.on('compaction_end')",
	session_before_tree: "hooks.on('before_navigation')",
	session_tree: "events.on('navigation_end')",
	session_start: '宿主生命周期（ExtensionRunner 自己发）',
	session_shutdown: '宿主生命周期（ExtensionRunner 自己发）',
	model_select: "events.on('config_update')（property === 'model'）",
	thinking_level_select: "events.on('config_update')（property === 'thinkingLevel'）",
	before_provider_request: "hooks.on('before_request')",
	before_provider_headers: "hooks.on('before_request')（streamOptions.headers 逐键增删）",
	after_provider_response: "hooks.on('after_response')",
};

/**
 * 不支持的事件名。分三类：
 *   · TUI：`ui_prompt_start` / `ui_prompt_end`
 *   · 宿主环境：`project_trust` / `resources_discover` / `user_bash`
 *   · 多会话 / 无对应物：`session_info_changed` / `session_before_switch` / `session_before_fork` /
 *     `session_compact_failed` / `input` / `agent_settled`
 */
export const UNSUPPORTED_EVENTS = [
	'project_trust',
	'resources_discover',
	'session_info_changed',
	'session_before_switch',
	'session_before_fork',
	'session_compact_failed',
	'ui_prompt_start',
	'ui_prompt_end',
	'user_bash',
	'input',
	'agent_settled',
] as const;
