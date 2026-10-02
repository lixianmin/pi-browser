// src/extensions/contract.ts —— S6 spec §2/§3.2/§3.4：上游名字的**唯一真源表**。
//
// 出处：@earendil-works/pi-coding-agent@0.99.1 `dist/core/extensions/types.d.ts`
//   ExtensionAPI（`on` + 31 个非 on 成员，共 32）、`ExtensionAPI.on` 的 41 个事件名、
//   ExtensionContext 18 个成员、ToolDefinition 字段（见 tool.ts）。
//   本次重抄的漂移（0.85.1 → 0.99.1）：API 成员 +6（`getSettings`、`registerMcpServer`/
//   `unregisterMcpServer`/`getMcpServers`、`registerVirtualModel`/`unregisterVirtualModel`）、
//   事件 +5（`mcp_servers_change`、`context_with_system`、`cache_warming_decision`、
//   `provider_stream_event`、`agent_before_settle`）、Context 成员 +1（`thinkingLevel`——上游两版都有，
//   0.85.1 那次抄写整条漏了，两份名单同时错所以双确认测试没报；本次逐字重对上游补回）。
// 纪律（S6 spec §3.1/§3.2）：
//   ① 对外面只允许出现下表中的名字，**不新增自造名**（S5 的 `defineExtension`/`composeToolset` 已删）；
//   ② 标 UNSUPPORTED 的名字**不得**在本仓另有实现（测试断言公开面上没有同名替代物）；
//   ③ 上游升级时：重抄三张名单（本文件承担对照基线），`test/extensions-contract.test.ts` 里另有一份
//      硬编码副本——两份都被改动才可能同时绿，这是刻意的双确认（防单点笔误漂移）。
//
// 「支持」判定规则（spec §3.4）：有直接对应物且我们现在有用例 → 支持；
// 有对应物但无用例 → 先声明不支持（YAGNI，保留原名不造替代名）；无对应物 → 不支持。

/** 上游 ExtensionAPI 的成员名（含 `on`；共 32）。 */
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
	'getSettings',
	'setActiveTools',
	'getCommands',
	'setModel',
	'getThinkingLevel',
	'setThinkingLevel',
	'registerProvider',
	'unregisterProvider',
	'registerMcpServer',
	'unregisterMcpServer',
	'getMcpServers',
	'registerVirtualModel',
	'unregisterVirtualModel',
	'events',
] as const;

/** 上游 ExtensionAPI.on 的事件名（41 个）。 */
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
	'mcp_servers_change',
	'session_before_tree',
	'session_tree',
	'context',
	'context_with_system',
	'cache_warming_decision',
	'input',
	'before_provider_request',
	'before_provider_headers',
	'after_provider_response',
	'provider_stream_event',
	'before_agent_start',
	'agent_start',
	'agent_end',
	'agent_before_settle',
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

/** 上游 ExtensionContext 的成员（18 个；`thinkingLevel` 是 0.85.1 那次抄写漏掉的，本次重抄补回）。 */
export const EXTENSION_CONTEXT_MEMBERS = [
	'ui',
	'mode',
	'hasUI',
	'cwd',
	'sessionManager',
	'modelRegistry',
	'model',
	'scopedModels',
	'thinkingLevel',
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

/**
 * 支持的 API 成员（14）：声明/查询工具、事件、账本条目、发用户消息、会话名/标签、模型与思考档位。
 * 落点见表（S6 spec §3.2）。
 */
export const SUPPORTED_API_MEMBERS = [
	'on',
	'registerTool',
	'getActiveTools',
	'getAllTools',
	'setActiveTools',
	'events',
	'appendEntry',
	'sendUserMessage',
	'setSessionName',
	'getSessionName',
	'setLabel',
	'setModel',
	'getThinkingLevel',
	'setThinkingLevel',
] as const;

/**
 * 不支持的 API 成员（18）：
 *   · 无 slash 命令面 / 无 TUI：`registerCommand` / `getCommands` / `registerShortcut` / `registerFlag` / `getFlag`
 *     / `registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer`；
 *   · provider 与模型目录都由 app 配置，扩展只选择不注册：`registerProvider` / `unregisterProvider` /
 *     `registerVirtualModel` / `unregisterVirtualModel`；
 *   · 本仓无对应物，不发明形状：`exec`（pi 的 `ExecResult` 与 pi-agent-core 的 `Result` 形状映射未核实）/ `sendMessage`
 *     （pi 的 `display` 是 TUI 渲染函数，进不了 `JsonValue`）；
 *   · 0.99.1 新增（逐条裁决见下）：`getSettings` / `registerMcpServer` / `unregisterMcpServer` / `getMcpServers`。
 *
 * 四条 0.99.1 新成员的裁决（本批 T1 结论，不许悬空）：
 *   · `getSettings` → 不支持：pi 的 `Settings`（`dist/core/settings-manager.d.ts`）是 CLI 设置对象（主题、快捷键、
 *     模型默认值等常驻进程配置），浏览器宿主没有设置面；宿主自己的配置住在 app 侧，不是扩展 API。
 *   · `registerMcpServer` / `unregisterMcpServer` / `getMcpServers` → 不支持：MCP 服务器需要进程/网络侧
 *     连接管理器（`dist/core/mcp-servers.ts`），pi-agent-core 与 pi-ai 里都没对应物——不发明一个旁路。
 *   · `registerVirtualModel` / `unregisterVirtualModel` → 不支持：虚拟模型是「可选中的目录条目 → 路由到物理模型」
 *     的替换项（需要 model registry + 模型解析），与已不支持的 `registerProvider` 同族（模型由 app 配置）。
 */
export const UNSUPPORTED_API_MEMBERS = [
	'registerCommand',
	'getCommands',
	'registerShortcut',
	'registerFlag',
	'getFlag',
	'registerMessageRenderer',
	'registerMarkdownTransformer',
	'registerEntryRenderer',
	'registerProvider',
	'unregisterProvider',
	'sendMessage',
	'exec',
	'getSettings',
	'registerMcpServer',
	'unregisterMcpServer',
	'getMcpServers',
	'registerVirtualModel',
	'unregisterVirtualModel',
] as const;

/** 支持的 Context 成员（5）：实际可兑现的只有这五个（`context.ts` 逐字段对齐）。 */
export const SUPPORTED_CONTEXT_MEMBERS = [
	'cwd',
	'model',
	'signal',
	'abort',
	'compact',
] as const;

/**
 * 不支持的 Context 成员（13）。四类理由：
 *   · TUI / 宿主进程概念：`ui` / `mode` / `hasUI` / `isProjectTrusted` / `shutdown`；
 *   · **同步/异步错位**：`isIdle` / `getContextUsage` / `getSystemPrompt` / `thinkingLevel`——上游是同步值，
 *     pi-agent-core 的对应操作是 `Promise`；要有真用例时由宿主另建缓存（本仓现在不用，不造假同步 API）；
 *   · 上游是 CLI 专属复合对象，**不发明形状**：`sessionManager` / `modelRegistry` / `scopedModels`；
 *   · 本仓无对应操作：`hasPendingMessages`（lane 无队列数 getter）。
 *
 * `thinkingLevel` 的额外说明：runner 侧确有思考档位缓存（API 的 `getThinkingLevel` / `setThinkingLevel` 已支持），
 * 但 `ExtensionContext` 面没有这个字段，也没有用例——按「有对应物但无用例 → 先声明不支持」归入上面第二类。
 */
export const UNSUPPORTED_CONTEXT_MEMBERS = [
	'ui',
	'mode',
	'hasUI',
	'sessionManager',
	'modelRegistry',
	'scopedModels',
	'thinkingLevel',
	'isIdle',
	'isProjectTrusted',
	'hasPendingMessages',
	'shutdown',
	'getContextUsage',
	'getSystemPrompt',
] as const;

/**
 * pi 事件名 → 落点（spec §3.4）。值 = 人类可读的落点说明；实现期由 `api.ts` 的映射表消费。
 *
 * **键必须是字面量联合**（`as const`，别再加 `Record<string, string>` 标注）：`api.ts` 的
 * `ExtensionEventMap` 靠它做编译期对照（`test/extensions-contract.test.ts` 钉住两边键集合一致）。
 * 标注成 `Record` 会让 `keyof` 退化成 `string`，那个对照就变成恒假——等于没钉。
 *
 * 四项「待核实」的裁决（S6 spec §3.4 要求 T1 给出结论，不许悬空）：
 *   · `before_provider_headers` → 支持：`hooks.on('before_request')` 返回 streamOptions patch，
 *     其 `headers` 支持逐键增删（pi-agent-core types.d.ts:94 / 106-108 实证）。
 *   · `agent_start` → 支持：`events.on('run_start')`。
 *   · `input` → **不支持**：pi-agent-core 没有能改写用户输入的钩子（`before_run` 只能追加 messages，
 *     改不了 input 文本 / 来源 / 投递方式）。
 *   · `agent_settled` → **不支持**：无 idle/settled 事件；`run_end` 与 `agent_end` 同源，区分不出 settled 语义。
 */
export const SUPPORTED_EVENTS = {
	context: "runner.emitContext(messages)",
	before_agent_start: "runner.emitBeforeAgentStart(prompt, images, systemPromptOptions, 宿主注入的渲染函数)",
	agent_start: "runner.emit({ type: 'agent_start' })",
	agent_end: "runner.emit({ type: 'agent_end', messages })",
	turn_start: "runner.emit({ type: 'turn_start', … })",
	turn_end: "runner.emitBoundary(baseEvent, 宿主注入的 buildContext)",
	message_start: "runner.emit({ type: 'message_start', … })",
	message_update: "runner.emit({ type: 'message_update', … })",
	message_end: "runner.emitMessageEnd(event)",
	tool_execution_start: "runner.emit({ type: 'tool_execution_start', … })",
	tool_execution_update: "runner.emit({ type: 'tool_execution_update', … })",
	tool_execution_end: "runner.emit({ type: 'tool_execution_end', … })",
	tool_call: "runner.emitToolCall(event)",
	tool_result: "runner.emitToolResult(event)",
	session_before_compact: "runner.emit({ type: 'session_before_compact', … })（cancel 短路）",
	session_compact: "runner.emit({ type: 'session_compact', … })",
	session_before_tree: "runner.emit({ type: 'session_before_tree', … })（cancel 短路）",
	session_tree: "runner.emit({ type: 'session_tree', … })",
	session_start: "runner.emit({ type: 'session_start', … })——由宿主发（reason 只有宿主知道）",
	session_shutdown: "runner.emit({ type: 'session_shutdown', … })——由宿主发",
	model_select: "runner.emit({ type: 'model_select', … })",
	thinking_level_select: "runner.emit({ type: 'thinking_level_select', … })",
	before_provider_request: "runner.emitBeforeProviderRequest(payload)",
	before_provider_headers: "runner.emitBeforeProviderHeaders(headers)（原地改）",
	after_provider_response: "runner.emit({ type: 'after_provider_response', … })",
} as const;

/**
 * 不支持的事件名（16）。分四类：
 *   · TUI：`ui_prompt_start` / `ui_prompt_end`
 *   · 宿主环境：`project_trust` / `resources_discover` / `user_bash`
 *   · 多会话 / 无对应物：`session_info_changed` / `session_before_switch` / `session_before_fork` /
 *     `session_compact_failed` / `input` / `agent_settled`
 *   · 0.99.1 新增（逐条裁决见下）：`mcp_servers_change` / `context_with_system` / `cache_warming_decision` /
 *     `provider_stream_event` / `agent_before_settle`
 *
 * 五条 0.99.1 新事件的裁决（本批 T1 结论，不许悬空）：
 *   · `mcp_servers_change` → 不支持：随 `registerMcpServer` 一组（载荷 `servers: RegisteredMcpServer[]`，本仓无 MCP 面）。
 *   · `context_with_system` → 不支持：语义是「所有 `context` handler 跑完、Pi 还原 prompt 与 tool 之后，交付
 *     **含 system 消息的完整 transcript**，且 handler **拥有 prompt 与 tool 声明**」。本仓 `context` 的落点
 *     `transform_context` 交付 `{messages(不含 system), systemPrompt}`、返回值只有 `{messages?, systemPrompt?}`
 *     ——tool 声明改不了，payload 形状也对不上（system 消息在数组里 vs 单独字段）。有直接对应物的那部分
 *     已被 `context` 覆盖，不另造「差不多」的形状。
 *   · `cache_warming_decision` → 不支持：pi 的 cache warmer（`dist/core/cache-warmer.ts`：预热决策
 *     `warmCost`/`missCost`/`continuationProbability`/`action`）是 CLI 常驻进程的缓存预热机制，本仓无对应物。
 *   · `provider_stream_event` → 不支持：交付 provider **归一化之前**的原始解析事件
 *     （`{provider, api, model, data: unknown}`）；harness 只给归一化后的 `message_*` / `tool_*`，本仓不穿透到原始流。
 *   · `agent_before_settle` → 不支持：载荷是 `BoundaryState`（会话边界草稿 + `continue` + 上下文预览 + outcome），
 *     CLI 会话管理器的复合对象；与已不支持的 `agent_settled` 同族（harness 只有 `run_end`，没有 settled 语义）。
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
	'mcp_servers_change',
	'context_with_system',
	'cache_warming_decision',
	'provider_stream_event',
	'agent_before_settle',
] as const;
