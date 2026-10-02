# pi-coding-agent 1.0.0 ExtensionAPI/Context/ToolDefinition —— 原样摘录

出处：`@earendil-works/pi-coding-agent@1.0.0 dist/core/extensions/types.d.ts`
提取方式：脚本按 interface 块取 4 空格缩进的成员起始行（非手工抄写）。

## ExtensionAPI
```ts
    on(event: "project_trust", handler: ProjectTrustHandler): () => void;
    on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): () => void;
    on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
    on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): () => void;
    on(event: "session_before_switch", handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): () => void;
    on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): () => void;
    on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): () => void;
    on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): () => void;
    on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): () => void;
    on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
    on(event: "mcp_servers_change", handler: ExtensionHandler<McpServersChangeEvent>): () => void;
    on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): () => void;
    on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): () => void;
    on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
    on(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>): () => void;
    on(event: "cache_warming_decision", handler: ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>): () => void;
    on(event: "before_provider_request", handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>): () => void;
    on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
    on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
    on(event: "provider_stream_event", handler: ExtensionHandler<ProviderStreamEvent>): () => void;
    on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): () => void;
    on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
    on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
    on(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>): () => void;
    on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
    on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): () => void;
    on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): () => void;
    on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
    on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>): () => void;
    on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
    on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
    on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): () => void;
    on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
    on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
    on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
    on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): () => void;
    on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): () => void;
    on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
    on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
    on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
    registerShortcut(shortcut: KeyId, options: {
    registerFlag(name: string, options: {
    getFlag(name: string): boolean | string | undefined;
    registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
    registerMarkdownTransformer(transformer: MarkdownTransformer): void;
    registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
    sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
    sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
    appendEntry<T = unknown>(customType: string, data?: T): void;
    setSessionName(name: string): void;
    getSessionName(): string | undefined;
    setLabel(entryId: string, label: string | undefined): void;
    exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
    getActiveTools(): string[];
    getAllTools(): ToolInfo[];
    getSettings(): Settings;
    setActiveTools(toolNames: string[]): void;
    getCommands(): SlashCommandInfo[];
    setModel(model: Model<any>): Promise<boolean>;
    getThinkingLevel(): ThinkingLevel;
    setThinkingLevel(level: ThinkingLevel): void;
    registerProvider(provider: Provider): void;
    registerProvider(name: string, config: ProviderConfig): void;
    unregisterProvider(name: string): void;
    registerMcpServer(name: string, config: McpServerConfig): void;
    unregisterMcpServer(name: string): void;
    getMcpServers(): RegisteredMcpServer[];
    registerVirtualModel<TState = unknown>(model: ExtensionVirtualModel<TState>): void;
    unregisterVirtualModel(provider: string, id: string): void;
    events: EventBus;
```

## ExtensionContext
```ts
    ui: ExtensionUIContext;
    mode: ExtensionMode;
    hasUI: boolean;
    cwd: string;
    sessionManager: ReadonlySessionManager;
    modelRegistry: ModelRegistry;
    model: Model<any> | undefined;
    scopedModels: readonly ScopedModel[];
    thinkingLevel?: ThinkingLevel;
    isIdle(): boolean;
    isProjectTrusted(): boolean;
    signal: AbortSignal | undefined;
    abort(): void;
    hasPendingMessages(): boolean;
    shutdown(): void;
    getContextUsage(): ContextUsage | undefined;
    compact(options?: CompactOptions): void;
    getSystemPrompt(): string;
```

## ToolDefinition
```ts
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: TParams;
    constrainedSampling?: false | ConstrainedSamplingConfig;
    renderShell?: "default" | "self";
    prepareArguments?: (args: unknown) => Static<TParams>;
    outputSchema?: TSchema;
    exposure?: ToolExposure;
    namespace?: ToolNamespace;
    annotations?: ToolAnnotations;
    defaultActive?: boolean;
    prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
    executionMode?: ToolExecutionMode;
    execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;
    renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
    renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
```

## on() 事件名（41，含重复则说明有重载）

```
project_trust resources_discover session_start session_info_changed session_before_switch session_before_fork session_before_compact session_compact session_compact_failed session_shutdown mcp_servers_change session_before_tree session_tree context context_with_system cache_warming_decision before_provider_request before_provider_headers after_provider_response provider_stream_event before_agent_start agent_start agent_end agent_before_settle agent_settled ui_prompt_start ui_prompt_end turn_start turn_end message_start message_update message_end tool_execution_start tool_execution_update tool_execution_end model_select thinking_level_select tool_call tool_result user_bash input
```
