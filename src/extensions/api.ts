// src/extensions/api.ts —— S6 spec §3.1/§3.2/§3.4：交给扩展的注册面（pi `ExtensionAPI` 同名同形）。
//
// 三条设计约束（不满足就别写）：
//   ① **只出现上游名字**（成员名/事件名逐字，见 contract.ts）；做不到的成员不实现、不造替代名。
//   ② **落点是 runtime，不是宿主绑定**（P3，spec C11）：每个成员的宿主侧实现都在
//      `runner.bindCore(actions, contextActions)` 拷进的那份 `ExtensionRuntime` 上。P2 之前这里直接抓
//      `harness`/`lane` 并自己维护「同步值缓存」（因为 core 的对应操作是 Promise）；注入模型下
//      `getSessionName()` / `getThinkingLevel()` / `getActiveTools()` 由宿主提供**同步**动作
//      （上游 `ExtensionActions` 就是同步的），所以那套缓存连同 fire-and-forget 一起删掉。
//   ③ **相位门**：注册期（扩展工厂执行中）调用运行期成员 → 响亮抛错；`close()` / `invalidate()` 之后同理。
//      闸门在 `hooks.assertActive`（runner 的 phase）与 runtime 的桩 / `assertActive` 两侧各有一道。
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { validateToolDefinition, type ToolDefinition } from './tool';
import type { ExtensionContext } from './context';
import type { ExtensionRuntime } from './runtime';
import type {
	AfterProviderResponseEvent, AgentEndEvent, AgentStartEvent, BeforeAgentStartEvent,
	BeforeAgentStartEventResult, BeforeProviderHeadersEvent, BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult, BoundaryContextPreview, BoundaryResult, BuildSystemPromptOptions,
	ContextEvent, ContextEventResult, MessageEndEvent, MessageEndEventResult, MessageStartEvent,
	MessageUpdateEvent, ModelSelectEvent, NormalizedBuildSystemPromptOptions, SessionBeforeCompactEvent,
	SessionBeforeCompactResult, SessionBeforeTreeEvent, SessionBeforeTreeResult, SessionCompactEvent,
	SessionShutdownEvent, SessionStartEvent, SessionTreeEvent, ThinkingLevelSelectEvent, ToolCallEvent,
	ToolCallEventResult, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent,
	ToolResultEvent, ToolResultEventResult, TurnEndEvent, TurnEndEventResult, TurnStartEvent,
} from './events';

/** 上游 `SourceInfo` 逐字段照抄；浏览器里 `path` 用合成的 `<extension:名字>`（无文件系统发现）。 */
export interface SourceInfo {
	path: string;
	source: string;
	scope: 'user' | 'project' | 'temporary';
	origin: 'package' | 'top-level';
	baseDir?: string;
}

/** 上游 `ToolInfo` 逐字段照抄（`getAllTools()` 的返回元素）。 */
export type ToolInfo = Pick<ToolDefinition, 'name' | 'description' | 'parameters' | 'promptGuidelines'> & {
	sourceInfo: SourceInfo;
};

/** 事件总线（pi 的 `pi.events` 同名同形：`on(type, listener)` 返回退订函数）。 */
export interface EventBus {
	on(type: string, listener: (event: unknown, context: ExtensionContext) => void | Promise<void>): () => void;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** 上游 `InlineExtension` 同名同形（带名字的工厂，用于报错溯源与工具来源标签）。 */
export interface InlineExtension {
	name: string;
	factory: ExtensionFactory;
}

export type Extension = ExtensionFactory | InlineExtension;

/** 宿主实现要交给 `createExtensionAPI` 的钩子（注册表与相位由 runner 持有）。 */
export interface ExtensionHostHooks {
	/** 来源标签（进 `SourceInfo.source` 与错误里的 `extensionPath`） */
	source: string;
	/** 相位门：注册期 / close 后调用运行期成员 → 抛错 */
	assertActive(): void;
	/** 收下一个已校验的工具声明（重名裁决与告警在 runner） */
	addTool(definition: ToolDefinition, source: string): void;
	/** 收下 `on(event, handler)` 的订阅（runner 负责分派、快照与错误上报）；返回退订函数 */
	onEvent(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>): () => void;
	/** 本次调用的上下文视图（`handler(event, ctx)` 的第二位） */
	contextFor(signal?: AbortSignal): ExtensionContext;
	/** `pi.events.on` 的落点：runtime 的事件总线订阅表（invalidate 时统一退订） */
	subscribeEventBus(type: string, listener: (event: unknown, context: ExtensionContext) => void | Promise<void>): () => void;
}

/**
 * 事件 handler 的签名（上游 `ExtensionHandler` 同名同形）：载荷 + 本次调用的 `ctx`，可返回结果。
 * `R` 缺省 `undefined`（无返回值的事件）。
 */
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * `on(event, handler)` 的事件表：**只列「支持」的事件**（名单真源 `contract.ts` 的 `SUPPORTED_EVENTS`），
 * 载荷类型逐字取自 `events.ts`（= 上游 `types.d.ts` 的同名接口，由 `test/extensions-events-types.test.ts`
 * 对着上游 `.d.ts` 逐字对照）。事件名是**封闭集合**：不在这里的名字编译期就红
 * （运行期检查见 `runner.onEvent()`，是第二道网）。
 */
export interface ExtensionEventMap {
	context: { event: ContextEvent; result: ContextEventResult };
	before_agent_start: { event: BeforeAgentStartEvent; result: BeforeAgentStartEventResult };
	agent_start: { event: AgentStartEvent };
	agent_end: { event: AgentEndEvent };
	turn_start: { event: TurnStartEvent };
	turn_end: { event: TurnEndEvent; result: TurnEndEventResult };
	message_start: { event: MessageStartEvent };
	message_update: { event: MessageUpdateEvent };
	message_end: { event: MessageEndEvent; result: MessageEndEventResult };
	tool_execution_start: { event: ToolExecutionStartEvent };
	tool_execution_update: { event: ToolExecutionUpdateEvent };
	tool_execution_end: { event: ToolExecutionEndEvent };
	tool_call: { event: ToolCallEvent; result: ToolCallEventResult };
	tool_result: { event: ToolResultEvent; result: ToolResultEventResult };
	session_before_compact: { event: SessionBeforeCompactEvent; result: SessionBeforeCompactResult };
	session_compact: { event: SessionCompactEvent };
	session_before_tree: { event: SessionBeforeTreeEvent; result: SessionBeforeTreeResult };
	session_tree: { event: SessionTreeEvent };
	session_start: { event: SessionStartEvent };
	session_shutdown: { event: SessionShutdownEvent };
	model_select: { event: ModelSelectEvent };
	thinking_level_select: { event: ThinkingLevelSelectEvent };
	before_provider_request: { event: BeforeProviderRequestEvent; result: BeforeProviderRequestEventResult };
	before_provider_headers: { event: BeforeProviderHeadersEvent };
	after_provider_response: { event: AfterProviderResponseEvent };
}

/** 取某个事件的返回值类型：表里没写 `result` 的事件 = 无结果（`undefined`）。 */
type EventResult<E extends keyof ExtensionEventMap> =
	ExtensionEventMap[E] extends { result: infer R } ? R : undefined;

export interface ExtensionAPI {
	/**
	 * 订阅事件。事件名是封闭集合（`ExtensionEventMap` 的键）。
	 * 不支持 / 未知事件名**编译期**就红；运行期仍有一道检查（`runner.onEvent()`，注册即抛并列出支持清单）。
	 */
	on<E extends keyof ExtensionEventMap>(
		event: E,
		handler: ExtensionHandler<ExtensionEventMap[E]['event'], EventResult<E>>,
	): () => void;
	registerTool(definition: ToolDefinition): void;
	getActiveTools(): string[];
	getAllTools(): ToolInfo[];
	setActiveTools(toolNames: string[]): void;
	appendEntry(customType: string, data?: unknown): void;
	sendUserMessage(content: string | unknown[], options?: { deliverAs?: 'steer' | 'followUp' }): void;
	setSessionName(name: string): void;
	getSessionName(): string | undefined;
	setLabel(entryId: string, label: string | undefined): void;
	setModel(model: Model<any>): Promise<boolean>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	events: EventBus;
}

/** 每个扩展一份 `ExtensionAPI`（来源标签不同 → 报错溯源与工具来源能定位到具体扩展）。 */
export function createExtensionAPI(runtime: ExtensionRuntime, hooks: ExtensionHostHooks): ExtensionAPI {
	const call = <T>(fn: () => T): T => {
		hooks.assertActive();   // 相位门：注册期 / close 后调用运行期成员一律响亮失败
		return fn();
	};

	return {
		on(event, handler) {
			// 分派在 runner（它持有订阅表与错误上报）；这里只补类型：载荷由宿主经 emit 交付
			return hooks.onEvent(event, (e, ctx) => handler(e as ExtensionEventMap[typeof event]['event'], ctx));
		},

		registerTool(definition) {
			// 注册在**加载期**合法，所以这里不过相位门（对齐 pi：registerTool 在扩展加载期有效）
			validateToolDefinition(definition);
			hooks.addTool(definition, hooks.source);
		},

		getActiveTools: () => call(() => [...runtime.getActiveTools()]),
		getAllTools: () => call(() => runtime.getAllTools()),
		setActiveTools: (toolNames) => call(() => runtime.setActiveTools([...toolNames])),
		appendEntry: (customType, data) => call(() => runtime.appendEntry(customType, data)),
		sendUserMessage: (content, options) => call(() => runtime.sendUserMessage(content as never, options)),

		setSessionName: (name) => call(() => runtime.setSessionName(name)),
		getSessionName: () => call(() => runtime.getSessionName()),
		setLabel: (entryId, label) => call(() => runtime.setLabel(entryId, label)),

		async setModel(model) {
			hooks.assertActive();
			return runtime.setModel(model);
		},
		getThinkingLevel: () => call(() => runtime.getThinkingLevel()),
		setThinkingLevel: (level) => call(() => runtime.setThinkingLevel(level)),

		events: {
			on: (type, listener) => hooks.subscribeEventBus(type, listener),
		},
	};
}
