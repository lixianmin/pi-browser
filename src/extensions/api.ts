// src/extensions/api.ts —— S6 spec §3.1/§3.2/§3.4：交给扩展的注册面（pi `ExtensionAPI` 同名同形）。
//
// 三条设计约束（不满足就别写）：
//   ① **只出现上游名字**（成员名/事件名逐字，见 contract.ts）；做不到的成员不实现、不造替代名。
//   ② **同步/异步错位要记账**：pi 的 `getSessionName()`/`getThinkingLevel()` 是同步值，而 pi-agent-core 的
//      对应操作是 `Promise`。宿主持一份**已知值缓存**（初始来自 bindings，写入时更新），同步 getter 读缓存；
//      外部绕过 API 改值的场景不在本仓用例内（已在类型注释写明）。
//   ③ **相位门**：注册期（扩展工厂执行中）调用运行期成员 → 响亮抛错（对齐 pi 的 `assertActive()`），
//      绝不静默用旧 context。
import type { AgentHarness, AgentLane, Context, HarnessEvent, HookInvocation, HookMap, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { validateToolDefinition, type ToolDefinition } from './tool';
import type { ExtensionContext } from './context';

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

/** 宿主绑定：`ExtensionRunner` 构造入参（可测：单元测试注入假 harness/lane）。 */
export interface ExtensionBindings {
	harness: AgentHarness;
	lane: AgentLane;
	/** 扩展拼路径用的工作目录 */
	cwd: string;
	/** 宿主当前模型（`ctx.model` 的来源） */
	model?: Model<any>;
	/** 应用侧停止信号（U13：harness 不自动穿透，必须显式转发） */
	signal?: AbortSignal;
	/** pi-agent-core 的 `Context`（每次 harness 调用都要它）；缺省由 runner 用 `BACKGROUND_CONTEXT` */
	context?: Context;
	/** 初始会话名（`getSessionName()` 的同步缓存起点） */
	sessionName?: string;
	/** 初始激活工具名单（`getActiveTools()` 的同步缓存起点；缺省空表） */
	activeTools?: string[];
	/** 初始思考档位（`getThinkingLevel()` 的同步缓存起点） */
	thinkingLevel: ThinkingLevel;
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
	/** 注册期调用运行期成员 → 抛错 */
	assertActive(): void;
	/** 收下一个已校验的工具声明（重名裁决与告警在 runner） */
	addTool(definition: ToolDefinition, source: string): void;
	/** 来源标签（进 `SourceInfo.source`） */
	source: string;
	/**
	 * 同步值缓存（会话名 / 思考档位 / 激活工具名单）：pi 的这三个成员是同步值，
	 * 而 pi-agent-core 的对应操作是 `Promise`。读写都走宿主，保证 getter 与 setter 自洽。
	 * 初始化来自 `ExtensionBindings`。
	 */
	cache: { sessionName?: string; thinkingLevel: ThinkingLevel; activeTools: string[] };
	/** 收下 `on(event, handler)` 的路由（runner 负责相位与生命周期分派；handler 已绑定本次调用的 ctx） */
	onEvent(event: string, handler: (event: unknown) => unknown | Promise<unknown>): void;
	/** 全部工具（含来源标签），供 `getAllTools()` */
	allTools(): ToolInfo[];
	/** 设置激活工具名单（写缓存 + 异步落到 lane） */
	setActiveTools(toolNames: string[]): void;
}

/** 宿主生命周期事件的订阅表（`session_start` / `session_shutdown` 由 runner 自己发）。 */
export type HostLifecycleListener = (event: { type: 'session_start' | 'session_shutdown' }) => void | Promise<void>;

/**
 * 事件 handler 的签名（上游 `ExtensionHandler` 同名同形）：载荷 + 本次调用的 `ctx`，可返回结果。
 * `R` 缺省 `undefined`（无返回值的事件）。
 */
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * `on(event, handler)` 的事件表：**只列「支持」的事件**（名单真源 `contract.ts` 的 `SUPPORTED_EVENTS`）。
 * 事件名逐字取自上游（不新增自造名）；但**载荷与返回值类型取自 pi-agent-core 的实际交付**，
 * 不是 pi 的同名事件类型——两者形状确实不同，拿 pi 的类型标注等于给使用者假信息：
 *   · `tool_call` → `hooks.on('before_tool')`：交付 `{toolCallId, toolName, args, lane, runId}`，
 *     而 pi 的 `ToolCallEvent` 是 `{type, toolCallId, toolName, input}`（`input` vs `args`，还多一个 `type`）；
 *     返回值同理（core 要 `{args?, block?}`，pi 靠原地改 `input`）。
 *   · `session_start` / `session_shutdown` 是宿主自造事件，只有 `type`（pi 的 `SessionStartEvent` 还有 `reason`）。
 * 事件名是**封闭集合**：不在这里的名字编译期就红（运行期检查见 `runner.route()`，是第二道网）。
 */
export interface ExtensionEventMap {
	// —— hook 路由（落点 = `harness.hooks`）——
	context: { event: HookInvocation<'transform_context'>; result: HookMap['transform_context']['result'] };
	before_agent_start: { event: HookInvocation<'before_run'>; result: HookMap['before_run']['result'] };
	tool_call: { event: HookInvocation<'before_tool'>; result: HookMap['before_tool']['result'] };
	tool_result: { event: HookInvocation<'after_tool'>; result: HookMap['after_tool']['result'] };
	session_before_compact: { event: HookInvocation<'before_compaction'>; result: HookMap['before_compaction']['result'] };
	session_before_tree: { event: HookInvocation<'before_navigation'>; result: HookMap['before_navigation']['result'] };
	before_provider_request: { event: HookInvocation<'before_request'>; result: HookMap['before_request']['result'] };
	// `before_provider_headers` 与 `before_provider_request` 同落点：headers 的增删靠同一个 streamOptions patch
	before_provider_headers: { event: HookInvocation<'before_request'>; result: HookMap['before_request']['result'] };
	after_provider_response: { event: HookInvocation<'after_response'>; result: HookMap['after_response']['result'] };

	// —— event 路由（落点 = `harness.events`）——
	agent_start: { event: Extract<HarnessEvent, { type: 'run_start' }> };
	agent_end: { event: Extract<HarnessEvent, { type: 'run_end' }> };
	turn_start: { event: Extract<HarnessEvent, { type: 'turn_start' }> };
	turn_end: { event: Extract<HarnessEvent, { type: 'turn_end' }> };
	message_start: { event: Extract<HarnessEvent, { type: 'message_start' }> };
	message_update: { event: Extract<HarnessEvent, { type: 'message_update' }> };
	message_end: { event: Extract<HarnessEvent, { type: 'message_end' }> };
	tool_execution_start: { event: Extract<HarnessEvent, { type: 'tool_start' }> };
	tool_execution_update: { event: Extract<HarnessEvent, { type: 'tool_update' }> };
	tool_execution_end: { event: Extract<HarnessEvent, { type: 'tool_end' }> };
	session_compact: { event: Extract<HarnessEvent, { type: 'compaction_end' }> };
	session_tree: { event: Extract<HarnessEvent, { type: 'navigation_end' }> };
	// 落点同为 `config_update`，靠 `property` 区分（runner.route() 里过滤）
	model_select: { event: Extract<HarnessEvent, { type: 'config_update'; property: 'model' }> };
	thinking_level_select: { event: Extract<HarnessEvent, { type: 'config_update'; property: 'thinkingLevel' }> };

	// —— 宿主生命周期（`ExtensionRunner` 自己发）——
	session_start: { event: { type: 'session_start' } };
	session_shutdown: { event: { type: 'session_shutdown' } };
}

/** 取某个事件的返回值类型：表里没写 `result` 的事件 = 无结果（`undefined`）。 */
type EventResult<E extends keyof ExtensionEventMap> =
	ExtensionEventMap[E] extends { result: infer R } ? R : undefined;

export interface ExtensionAPI {
	/**
	 * 订阅事件。事件名是封闭集合（`ExtensionEventMap` 的键），载荷与返回值类型 = pi-agent-core 的实际交付。
	 * 不支持 / 未知事件名**编译期**就红；运行期仍有一道检查（`runner.route()`，注册即抛并列出支持清单）。
	 */
	on<E extends keyof ExtensionEventMap>(
		event: E,
		handler: ExtensionHandler<ExtensionEventMap[E]['event'], EventResult<E>>,
	): void;
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
export function createExtensionAPI(
	bindings: ExtensionBindings,
	hooks: ExtensionHostHooks,
	contextFor: (signal?: AbortSignal) => ExtensionContext,
): ExtensionAPI {
	const ctx = (): Context => {
		if (!bindings.context) throw new Error('ExtensionRunner：bindings.context 缺失（宿主必须注入 pi-agent-core Context）');
		return bindings.context;
	};
	const call = <T>(fn: () => T): T => {
		hooks.assertActive();   // 相位门：注册期调用运行期成员一律响亮失败
		return fn();
	};
	const fireAndForget = (p: Promise<unknown>, what: string): void => {
		void p.catch((e: unknown) => console.warn(`[extensions] ${hooks.source}.${what} 失败：${(e as Error)?.message ?? String(e)}`));
	};

	return {
		on(event, handler) {
			// 运行期仍是 string 路由（相位门与分派在 runner）；这里的 cast 只补类型：载荷由 pi-agent-core 交付
			hooks.onEvent(event, (e) => handler(e as ExtensionEventMap[typeof event]['event'], contextFor()));
		},

		registerTool(definition) {
			// 注册在**加载期**合法，所以这里不过相位门（对齐 pi：registerTool 在扩展加载期有效）
			validateToolDefinition(definition);
			hooks.addTool(definition, hooks.source);
		},

		getActiveTools: () => call(() => [...hooks.cache.activeTools]),
		getAllTools: () => call(() => hooks.allTools()),
		setActiveTools: (toolNames) => call(() => {
			hooks.cache.activeTools = [...toolNames];   // 同步缓存：pi 的 getActiveTools() 是同步值
			hooks.setActiveTools([...toolNames]);
		}),

		appendEntry(customType, data) {
			call(() => fireAndForget(bindings.lane.appendCustomEntry(customType, data as never, ctx()), 'appendEntry'));
		},

		sendUserMessage(content, options) {
			call(() => {
				const deliverAs = options?.deliverAs ?? 'steer';
				const message = typeof content === 'string'
					? content
					: { role: 'user' as const, content, timestamp: Date.now() };
				const p = deliverAs === 'followUp'
					? bindings.lane.followUp(message as never, undefined, ctx())
					: bindings.lane.steer(message as never, undefined, ctx());
				fireAndForget(p, 'sendUserMessage');
			});
		},

		setSessionName(name) {
			call(() => {
				hooks.cache.sessionName = name;
				fireAndForget(bindings.harness.setName(name, ctx()), 'setSessionName');
			});
		},
		// 同步读缓存：pi 的这个成员是同步值，pi-agent-core 的 getName 是 Promise（见文件头约束②）
		getSessionName: () => call(() => hooks.cache.sessionName),

		setLabel(entryId, label) {
			call(() => fireAndForget(bindings.harness.setLabel(entryId, label, ctx()), 'setLabel'));
		},

		async setModel(model) {
			hooks.assertActive();
			await bindings.lane.setModel({ provider: model.provider, modelId: model.id } as never, ctx());
			return true;
		},
		getThinkingLevel: () => call(() => hooks.cache.thinkingLevel),
		setThinkingLevel(level) {
			call(() => {
				hooks.cache.thinkingLevel = level;
				fireAndForget(bindings.lane.setThinkingLevel(level, ctx()), 'setThinkingLevel');
			});
		},

		events: {
			on(type, listener) {
				return bindings.harness.events.on(type as never, ((event: unknown) => listener(event, contextFor())) as never);
			},
		},
	};
}
