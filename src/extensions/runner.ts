// src/extensions/runner.ts —— P3（spec C11/F16/F17/D4/R6）：浏览器侧**宿主**（pi `ExtensionRunner` 同名）。
//
// 换注入模型的理由：P2 之前本文件在**构造期**抓 `harness` / `lane`，事件路由挂在 `harness.hooks` /
// `harness.events` 上（25 条）。上游 1.0.0 改成「宿主先造 runtime（动作全是抛错 stub），runner 在
// `bindCore` 时把真动作拷进去；事件由宿主在对的时机调 runner 自己的 emit 入口」。本文件照抄这个形状：
//   ① 构造收窄为 `(extensions, runtime, cwd)`（D4：上游的 `sessionManager` 写 1 读 0、`modelRegistry`
//      只服务本仓已判「不支持」的 provider / 虚拟模型面，两个都不收，也不造 stub；F17/R7 留待升级复查）；
//   ② `bindCore(actions, contextActions)` 把宿主动作拷进共享 runtime（扩展面每个成员都不带 context，
//      指向同一份 runtime 就是「context 反演」的落点）；传 `providerActions` 就抛（不支持面）；
//   ③ 事件分派照抄上游：有结果语义的走具名 `emitXxx`，其余走通用 `emit(event)`；handler 抛错不外泄，
//      统一走 `emitError` 上报（`ExtensionError` 形状也照抄）。
//
// 逐字照抄与有意偏差（理由逐条写在这里，不藏在实现里）：
//   · `emit` / 具名 emit 的控制流、订阅快照语义、`ExtensionError`、`session_before_*` 的 cancel 短路 → 照抄。
//   · `session_start` / `session_shutdown` 改由**宿主**经 `emit` 发（上游就是这样，`reason` 字段也只有
//     宿主知道）；旧实现在 `load()` / `close()` 里自己发，那是在假装知道会话为何启动/关闭。
//   · `context` 只跑上游的**第一相**（第二相 `context_with_system` 在本仓是 UNSUPPORTED，理由见
//     contract.ts）。第一相的「handler 只看不含 system 的会话、每轮后还原 prompt 与工具状态」照抄，
//     其依赖的 pi-ai `getCurrentSystemMessage` / `getCurrentTools` 在本文件末尾逐字转写
//     （pi-ai@0.99.1 根入口不导出这两个函数；P6 升到 1.0.0 后换成 import）。
//   · `before_agent_start` 的 system prompt 渲染函数由**宿主注入**（上游直接 import CLI 仓的
//     `buildSystemPrompt`；浏览器侧没有 system prompt 构造器，宿主才是它的所有者）——与本仓 D5 的
//     operations 注入缝同款，不是新发明。
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { contentText, type ImageContent, type ProviderHeaders, type SystemMessage, type Tool } from '@earendil-works/pi-ai';
import { SUPPORTED_EVENTS, UNSUPPORTED_EVENTS } from './contract';
import { createExtensionAPI, type Extension, type ExtensionAPI, type SourceInfo } from './api';
import { createExtensionContext, type ExtensionContext } from './context';
import type {
	BeforeAgentStartEvent, BeforeAgentStartEventResult, BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent, BoundaryContextPreview, BoundaryResult, BuildSystemPromptOptions,
	ContextEvent, MessageEndEvent, MessageEndEventResult, NormalizedBuildSystemPromptOptions,
	SessionBeforeCompactResult, SessionBeforeTreeResult, SessionBoundaryDraft,
	SupportedExtensionEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent,
	ToolResultEventResult, TurnEndEvent,
} from './events';
import { bindCore, type ExtensionActions, type ExtensionContextActions, type ExtensionRuntime } from './runtime';
import type { ToolDefinition } from './tool';

/** 上游 `ExtensionError` 逐字（`types.d.ts:1705`）。 */
export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}

export type ExtensionErrorListener = (error: ExtensionError) => void;

/** 一个订阅：来源标签（= 上游的 `ext.path`，浏览器里是合成名）+ handler。 */
interface Subscription {
	path: string;
	handler: (event: unknown, ctx: ExtensionContext) => unknown;
}

/** 已注册工具（上游 `RegisteredTool` 同形；`sourceInfo` 在 `api.ts`）。 */
export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

/** 通用 `emit` 覆盖的事件（上游 `RunnerEmitEvent`：有专用 `emitXxx` 的事件被排除以换取更强的类型）。 */
export type RunnerEmitEvent = Exclude<
	SupportedExtensionEvent,
	| ToolCallEvent | ToolResultEvent | ContextEvent | BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent | BeforeAgentStartEvent | MessageEndEvent | TurnEndEvent
>;

/** 通用 `emit` 的返回值（上游 `RunnerEmitResult`：只有 `session_before_*` 带结果，其余恒 `undefined`）。 */
export type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: 'session_before_compact' }
	? SessionBeforeCompactResult | undefined
	: TEvent extends { type: 'session_before_tree' }
		? SessionBeforeTreeResult | undefined
	: undefined;

/** 回合边界分派的返回值（上游 `BoundaryDispatchResult`）。 */
export interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

/** `turn_end` 的基底：边界字段（entries/continue/context）由 runner 逐步喂给 handler（上游 `BoundaryBaseEvent`）。 */
export type BoundaryBaseEvent = Omit<TurnEndEvent, 'entries' | 'continue' | 'context'>;

/** 宿主渲染 system prompt 的能力（`before_agent_start` 的 `systemPrompt` 字段来源）。 */
export type SystemPromptRenderer = (options: NormalizedBuildSystemPromptOptions) => string;

/** 边界草稿 → 上下文预览（上游由宿主提供：扩展改草稿后，runner 让它重算）。 */
export type BoundaryContextBuilder = (
	entries: SessionBoundaryDraft[],
) => BoundaryContextPreview | Promise<BoundaryContextPreview>;

/** `before_agent_start` 的聚合结果（上游 `BeforeAgentStartCombinedResult`）。 */
export interface BeforeAgentStartCombinedResult {
	messages: NonNullable<BeforeAgentStartEventResult['message']>[];
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/**
 * 宿主：装载扩展 → 收工具与事件订阅 → 交给宿主消费。
 * `load()` 跑完工厂后进入 `active` 相位；此前扩展工厂里调用运行期成员会**响亮抛错**（对齐 pi 的
 * `assertActive()` 与 loader 的抛错 stub 两道闸）。
 */
export class ExtensionRunner {
	private readonly handlers = new Map<string, Subscription[]>();
	private readonly eventBus = new Map<string, Subscription[]>();
	private readonly registered = new Map<string, RegisteredTool>();
	private readonly apiPerSource = new Map<string, ExtensionAPI>();
	private readonly errorListeners = new Set<ExtensionErrorListener>();
	private phase: 'loading' | 'active' = 'loading';
	private contextActions: ExtensionContextActions | undefined;

	constructor(
		private readonly extensions: readonly Extension[],
		private readonly runtime: ExtensionRuntime,
		private readonly cwd: string,
	) {}

	/**
	 * 注入宿主能力（上游 `bindCore` 的对应一步）：动作拷进共享 runtime，上下文动作留在 runner 里给
	 * `createContext()` 用。`providerActions` 属于本仓「不支持」的 provider / 虚拟模型面，传了就抛。
	 */
	bindCore(actions: ExtensionActions, contextActions: ExtensionContextActions, providerActions?: unknown): void {
		if (providerActions !== undefined) {
			throw new Error('ExtensionRunner：providerActions 属于不支持面（provider / 虚拟模型注册），本仓不实现');
		}
		bindCore(this.runtime, actions);
		this.contextActions = contextActions;
		this.runtime.createContext = () => this.createContext();
	}

	/** 已注册工具（含来源标签），保持注册顺序（Map 插入序）。 */
	getAllRegisteredTools(): RegisteredTool[] {
		return [...this.registered.values()];
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.registered.get(name)?.definition;
	}

	/** 某事件有没有订阅者（宿主据此决定要不要做前置工作；上游同名）。 */
	hasHandlers(eventType: string): boolean {
		const handlers = this.handlers.get(eventType);
		return handlers !== undefined && handlers.length > 0;
	}

	/**
	 * 装载扩展：跑完各扩展工厂（可 await）并收下工具与订阅。
	 * 返回装载好的 `ExtensionAPI` 列表（宿主可直接调运行期成员）。
	 */
	async load(): Promise<Map<string, ExtensionAPI>> {
		this.phase = 'loading';
		let anonymous = 0;
		for (const ext of this.extensions) {
			const named = typeof ext === 'function' ? undefined : ext;
			const factory = typeof ext === 'function' ? ext : ext.factory;
			const source = named?.name ?? `<anonymous:${++anonymous}>`;
			await factory(this.apiFor(source));
		}
		this.phase = 'active';
		return this.apiPerSource;
	}

	/** 关掉宿主：作废 runtime（ctx 与事件总线订阅一并失效）并把相位落回 `loading`。 */
	async close(): Promise<void> {
		this.runtime.invalidate('ExtensionRunner：宿主已 close，拿到的 ctx 与订阅不可再用');
		this.phase = 'loading';
	}

	/** 标记本扩展实例失效（上游同名；`session_shutdown` 之后由宿主调用）。 */
	invalidate(message?: string): void {
		this.runtime.invalidate(message);
	}

	/** 订阅扩展错误（照抄上游 `onError`）：每个 emit 捕获的 handler 异常都从这里出去。 */
	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) listener(error);
	}

	/** 给某个扩展用的 `ExtensionAPI` 实例（来源标签不同 ⇒ 报错与工具来源能定位到扩展）。 */
	apiFor(source: string): ExtensionAPI {
		const existing = this.apiPerSource.get(source);
		if (existing) return existing;
		const api = createExtensionAPI(this.runtime, {
			source,
			assertActive: () => {
				if (this.phase !== 'active') {
					throw new Error(`扩展 "${source}"：注册期不能调用运行期成员（扩展工厂只能 registerTool / on / 声明）`);
				}
				this.runtime.assertActive();
			},
			addTool: (definition, from) => this.addTool(definition, from),
			onEvent: (event, handler) => this.onEvent(source, event, handler),
			contextFor: (signal) => this.createContext(signal),
			subscribeEventBus: (type, listener) => this.onEventBus(source, type, listener),
		});
		this.apiPerSource.set(source, api);
		return api;
	}

	/**
	 * 扩展 handler 拿到的上下文（上游 `createContext`）。bindCore 之前调用 → 抛（照抄上游：没有注入的
	 * 上下文动作就没有可兑现的成员）。每次调用新建一份，成员是惰性 getter，所以换模型/换信号立刻可见。
	 */
	createContext(invocationSignal?: AbortSignal): ExtensionContext {
		const contextActions = this.contextActions;
		if (!contextActions) {
			throw new Error('ExtensionRuntime：createContext 需要宿主先 bindCore(actions, contextActions)');
		}
		return createExtensionContext({
			cwd: this.cwd,
			contextActions,
			assertActive: () => this.runtime.assertActive(),
			invocationSignal,
		});
	}

	// ———— 事件分派（照抄上游；宿主在对应时机调用）————

	/**
	 * 通用 emit：逐订阅跑一遍 handler。`session_before_*` 收集返回值并在 `cancel` 时短路（上游同款：
	 * 第一个要求取消的订阅说了算）。handler 抛错不外泄，走 `emitError`。
	 */
	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		let result: unknown;
		for (const { path, handler } of this.snapshot(event.type)) {
			try {
				const handlerResult = await handler(event, ctx);
				if (this.isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult;
					if ((result as { cancel?: boolean }).cancel) return result as RunnerEmitResult<TEvent>;
				}
			} catch (err) {
				this.emitError(this.toError(path, event.type, err));
			}
		}
		return result as RunnerEmitResult<TEvent>;
	}

	/** 工具执行前：最后一个非空结果生效，`block` 立刻短路（上游同款）。handler 抛错直接冒泡给宿主。 */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;
		for (const { handler } of this.snapshot('tool_call')) {
			const handlerResult = await handler(event, ctx) as ToolCallEventResult | void;
			if (handlerResult) {
				result = handlerResult;
				if (result.block) return result;
			}
		}
		return result;
	}

	/** 工具执行后：把 handler 的改写合到一份结果上（换了 content 却没同时换 structuredContent 时丢弃后者）。 */
	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent = { ...event };
		let modified = false;
		for (const { path, handler } of this.snapshot('tool_result')) {
			try {
				const handlerResult = await handler(currentEvent, ctx) as ToolResultEventResult | void;
				if (!handlerResult) continue;
				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					// Structured content that is not replaced along with the content may no longer match it.
					if (handlerResult.structuredContent === undefined) delete currentEvent.structuredContent;
					modified = true;
				}
				// `details` 逐分支而异（bash 有 details、write 是 undefined），统一按 unknown 读写
				if (handlerResult.details !== undefined) {
					(currentEvent as { details?: unknown }).details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.structuredContent !== undefined) {
					currentEvent.structuredContent = handlerResult.structuredContent;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
				if (handlerResult.usage !== undefined) {
					currentEvent.usage = handlerResult.usage;
					modified = true;
				}
			} catch (err) {
				this.emitError(this.toError(path, 'tool_result', err));
			}
		}
		if (!modified) return undefined;
		return {
			content: currentEvent.content,
			details: (currentEvent as { details?: unknown }).details,
			structuredContent: currentEvent.structuredContent,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		};
	}

	/**
	 * 回合边界（`turn_end`）：handler 可以换草稿、决定是否继续；每次换完由宿主的 `buildContext` 重算上下文，
	 * 重算抛错 → `valid: false`（草稿不可用，宿主据此回退）。
	 */
	async emitBoundary(
		baseEvent: BoundaryBaseEvent,
		buildContext: BoundaryContextBuilder,
	): Promise<BoundaryDispatchResult> {
		const ctx = this.createContext();
		let entries: SessionBoundaryDraft[] = [];
		let shouldContinue = false;
		let context = await buildContext(entries);
		let valid = true;
		for (const { path, handler } of this.snapshot(baseEvent.type)) {
			try {
				const event = { ...baseEvent, entries, continue: shouldContinue, context };
				const handlerResult = await handler(event, ctx) as BoundaryResult | void;
				if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
				if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
			} catch (err) {
				this.emitError(this.toError(path, baseEvent.type, err));
			}
			try {
				context = await buildContext(entries);
				valid = true;
			} catch (err) {
				valid = false;
				this.emitError({
					extensionPath: path,
					event: baseEvent.type,
					error: `Invalid boundary entries: ${errText(err)}`,
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		return valid
			? { entries, continue: shouldContinue, context, valid: true }
			: { entries: [], continue: false, context, valid: false };
	}

	/**
	 * 每次 LLM 调用前的 `context` 变换（上游 `emitContext` 的第一相）：handler 只看不含 system 的会话，
	 * 返回新列表或原地改都收；每轮之后把 prompt 与工具状态还原回头部（上游同款，system 消息归宿主所有）。
	 */
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();
		let currentMessages = structuredClone(messages);
		for (const { path, handler } of this.snapshot('context')) {
			try {
				const visibleMessages = currentMessages.filter((message) => message.role !== 'system');
				const visibleSnapshot = visibleMessages.slice();
				const event: ContextEvent = { type: 'context', messages: visibleMessages };
				const handlerResult = await handler(event, ctx) as { messages?: AgentMessage[] } | void;
				// Handlers may return a new list or edit event.messages in place.
				const returned = handlerResult?.messages
					?? (sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
				if (!returned) continue;
				currentMessages = restoreSystemMessages(currentMessages, visibleSnapshot, returned);
			} catch (err) {
				this.emitError(this.toError(path, 'context', err));
			}
		}
		return currentMessages;
	}

	/** `message_end`：替换定稿消息（角色必须一致，否则报错并忽略该次替换；上游同款）。 */
	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;
		for (const { path, handler } of this.snapshot('message_end')) {
			try {
				const currentEvent = { ...event, message: currentMessage };
				const handlerResult = await handler(currentEvent, ctx) as MessageEndEventResult | void;
				if (!handlerResult?.message) continue;
				if (handlerResult.message.role !== currentMessage.role) {
					this.emitError({
						extensionPath: path,
						event: 'message_end',
						error: 'message_end handlers must return a message with the same role',
					});
					continue;
				}
				currentMessage = handlerResult.message;
				modified = true;
			} catch (err) {
				this.emitError(this.toError(path, 'message_end', err));
			}
		}
		return modified ? currentMessage : undefined;
	}

	/** 每次 provider 请求前：handler 返回非 `undefined` 即整体替换载荷（后写覆盖先写）。 */
	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		const ctx = this.createContext();
		let currentPayload = payload;
		for (const { path, handler } of this.snapshot('before_provider_request')) {
			try {
				const event: BeforeProviderRequestEvent = { type: 'before_provider_request', payload: currentPayload };
				const handlerResult = await handler(event, ctx);
				if (handlerResult !== undefined) currentPayload = handlerResult;
			} catch (err) {
				this.emitError(this.toError(path, 'before_provider_request', err));
			}
		}
		return currentPayload;
	}

	/** 请求头组装后：handler **原地改** `headers`（返回值被忽略），`null` 值表示删该头（上游同款）。 */
	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		const ctx = this.createContext();
		for (const { path, handler } of this.snapshot('before_provider_headers')) {
			try {
				const event: BeforeProviderHeadersEvent = { type: 'before_provider_headers', headers };
				await handler(event, ctx);
			} catch (err) {
				this.emitError(this.toError(path, 'before_provider_headers', err));
			}
		}
		return headers;
	}

	/**
	 * agent 循环开始前：收 handler 追加的消息，并让后一个 handler 看到前一个的 system prompt 覆盖
	 * （`systemPrompt` 由宿主注入的渲染函数给出——浏览器侧没有 system prompt 构造器，宿主才是它的所有者）。
	 */
	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPromptOptions: BuildSystemPromptOptions,
		renderSystemPrompt: SystemPromptRenderer,
	): Promise<BeforeAgentStartCombinedResult> {
		const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);
		const messages: NonNullable<BeforeAgentStartEventResult['message']>[] = [];
		const ctx = this.createContext();
		for (const { path, handler } of this.snapshot('before_agent_start')) {
			try {
				const event: BeforeAgentStartEvent = {
					type: 'before_agent_start',
					prompt,
					images,
					get systemPrompt() {
						return renderSystemPrompt(currentOptions);
					},
					systemPromptOptions: currentOptions,
				};
				const handlerResult = await handler(event, ctx) as BeforeAgentStartEventResult | void;
				if (!handlerResult) continue;
				if (handlerResult.message) messages.push(handlerResult.message);
				if (handlerResult.systemPrompt !== undefined) {
					currentOptions.forceSystemPrompt = handlerResult.systemPrompt;
				}
			} catch (err) {
				this.emitError(this.toError(path, 'before_agent_start', err));
			}
		}
		return { messages, systemPromptOptions: currentOptions };
	}

	// ———— `pi.events` 事件总线（订阅面在扩展上，生产面在宿主上）————

	/** 订阅事件总线（`pi.events.on` 的落点）。订阅交给 runtime 保管，`invalidate` 时统一退订。 */
	onEventBus(source: string, type: string, listener: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): () => void {
		const unsubscribe = this.push(this.eventBus, type, {
			path: `<extension:${source}>`,
			handler: (event, ctx) => listener(event, ctx),
		});
		return this.runtime.trackEventBusSubscription(unsubscribe);
	}

	/** 事件总线的生产面：宿主在对应时机把内部事件喂给 `pi.events` 的订阅者。 */
	async emitEventBus(type: string, event: unknown): Promise<void> {
		const ctx = this.createContext();
		for (const { path, handler } of this.snapshotBus(type)) {
			try {
				await handler(event, ctx);
			} catch (err) {
				this.emitError(this.toError(path, type, err));
			}
		}
	}

	// ———— 内部 ————

	private addTool(definition: ToolDefinition, source: string): void {
		const previous = this.registered.get(definition.name);
		if (previous) {
			// 对齐 pi 宿主语义（Map.set：后写覆盖先写），差异只有这一行告警 —— spec §3.5
			console.warn(`[extensions] 工具重名："${definition.name}"：${previous.sourceInfo.source} 被 ${source} 覆盖`);
		}
		this.registered.set(definition.name, {
			definition,
			sourceInfo: {
				// 浏览器里扩展是宿主自己的对象（不经文件系统发现）：path 用合成名，scope 固定 project
				path: `<extension:${source}>`,
				source,
				scope: 'project',
				origin: 'top-level',
			},
		});
	}

	private onEvent(
		source: string,
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => unknown,
	): () => void {
		if (!(event in SUPPORTED_EVENTS)) {
			throw new Error(`扩展 "${source}"：on("${event}") 不支持（`
				+ `${(UNSUPPORTED_EVENTS as readonly string[]).includes(event) ? '该事件在浏览器侧无对应物' : '未知事件名'}）。`
				+ `支持：${Object.keys(SUPPORTED_EVENTS).join(', ')}`);
		}
		return this.push(this.handlers, event, { path: `<extension:${source}>`, handler });
	}

	private push(table: Map<string, Subscription[]>, key: string, subscription: Subscription): () => void {
		const list = table.get(key);
		if (list) list.push(subscription);
		else table.set(key, [subscription]);
		return () => {
			const current = table.get(key);
			if (!current) return;
			const index = current.indexOf(subscription);
			if (index >= 0) current.splice(index, 1);
		};
	}

	/** 稳定快照（上游 `snapshotEventHandlers`：handler 可以在自己执行时退订/注册，不影响本轮）。 */
	private snapshot(event: string): Subscription[] {
		return (this.handlers.get(event) ?? []).slice();
	}

	private snapshotBus(event: string): Subscription[] {
		return (this.eventBus.get(event) ?? []).slice();
	}

	private isSessionBeforeEvent(event: { type: string }): boolean {
		return event.type === 'session_before_switch'
			|| event.type === 'session_before_fork'
			|| event.type === 'session_before_compact'
			|| event.type === 'session_before_tree';
	}

	private toError(extensionPath: string, event: string, err: unknown): ExtensionError {
		return {
			extensionPath,
			event,
			error: errText(err),
			stack: err instanceof Error ? err.stack : undefined,
		};
	}
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 上游 `runner.js:90`（同数组同引用即视为未改）。 */
function sameMessages(left: AgentMessage[], right: AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * Re-attach the prompt and tool state after a `context` handler（上游 `runner.js:101` 逐字）。
 * 未改动的会话保留全部 system 消息原位；改动过的把重放后的 prompt 与工具声明作为一条头部 system 消息补回，
 * 这样裁剪/开窗/压缩切片都不会把 prompt 丢掉。
 */
function restoreSystemMessages(
	current: AgentMessage[],
	visible: AgentMessage[],
	returned: AgentMessage[],
): AgentMessage[] {
	if (sameMessages(returned, visible)) return current;
	const head = getCurrentSystemMessage(current);
	return head ? [head, ...returned] : returned;
}

/** 上游 `system-prompt.js:32` 的归一（逐字：缺的集合字段补空缺）。 */
function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		...input,
		selectedTools: input.selectedTools ?? [],
		toolSnippets: input.toolSnippets ?? {},
		toolGuidelines: input.toolGuidelines ?? {},
		promptGuidelines: input.promptGuidelines ?? [],
		appendSystemPrompt: input.appendSystemPrompt ?? '',
		sections: input.sections ?? {},
		contextFiles: input.contextFiles ?? [],
		skills: input.skills ?? [],
	};
}

/** pi-ai@1.0.0 `utils/transcript.ts:58`（逐字转写：0.99.1 根入口不导出，P6 升版本后换回 import）。 */
function getCurrentSystemMessage(messages: readonly { role: string }[]): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (message.role !== 'system') continue;
		timestamp ??= (message as SystemMessage).timestamp;
		const text = contentText((message as SystemMessage).content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries((message as SystemMessage).sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: 'system',
		content: content.join('\n\n'),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** pi-ai@1.0.0 `utils/transcript.ts:48`（逐字转写，同上）。 */
function getCurrentTools(messages: readonly { role: string }[]): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== 'system') continue;
		const system = message as SystemMessage;
		for (const tool of system.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}
