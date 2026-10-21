import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { type ImageContent, type ProviderHeaders } from '@earendil-works/pi-ai';
import { type Extension, type ExtensionAPI, type SourceInfo } from './api.js';
import { type ExtensionContext } from './context.js';
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, BeforeProviderHeadersEvent, BeforeProviderRequestEvent, BoundaryContextPreview, BuildSystemPromptOptions, ContextEvent, MessageEndEvent, NormalizedBuildSystemPromptOptions, SessionBeforeCompactResult, SessionBeforeTreeResult, SessionBoundaryDraft, SupportedExtensionEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult, TurnEndEvent } from './events.js';
import { type ExtensionActions, type ExtensionContextActions, type ExtensionRuntime } from './runtime.js';
import type { ToolDefinition } from './tool.js';
/** 上游 `ExtensionError` 逐字（`types.d.ts:1705`）。 */
export interface ExtensionError {
    extensionPath: string;
    event: string;
    error: string;
    stack?: string;
}
export type ExtensionErrorListener = (error: ExtensionError) => void;
/** 已注册工具（上游 `RegisteredTool` 同形；`sourceInfo` 在 `api.ts`）。 */
export interface RegisteredTool {
    definition: ToolDefinition;
    sourceInfo: SourceInfo;
}
/** 通用 `emit` 覆盖的事件（上游 `RunnerEmitEvent`：有专用 `emitXxx` 的事件被排除以换取更强的类型）。 */
export type RunnerEmitEvent = Exclude<SupportedExtensionEvent, ToolCallEvent | ToolResultEvent | ContextEvent | BeforeProviderRequestEvent | BeforeProviderHeadersEvent | BeforeAgentStartEvent | MessageEndEvent | TurnEndEvent>;
/** 通用 `emit` 的返回值（上游 `RunnerEmitResult`：只有 `session_before_*` 带结果，其余恒 `undefined`）。 */
export type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends {
    type: 'session_before_compact';
} ? SessionBeforeCompactResult | undefined : TEvent extends {
    type: 'session_before_tree';
} ? SessionBeforeTreeResult | undefined : undefined;
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
export type BoundaryContextBuilder = (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>;
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
export declare class ExtensionRunner {
    private readonly extensions;
    private readonly runtime;
    private readonly cwd;
    private readonly handlers;
    private readonly eventBus;
    private readonly registered;
    private readonly apiPerSource;
    private readonly errorListeners;
    private phase;
    private closed;
    /** 单飞槽：并发的 `load()` 共用同一次装载（否则两次都清表再各注册一遍 → handler 跑两遍） */
    private loading;
    private contextActions;
    constructor(extensions: readonly Extension[], runtime: ExtensionRuntime, cwd: string);
    /**
     * 注入宿主能力（上游 `bindCore` 的对应一步）：动作拷进共享 runtime，上下文动作留在 runner 里给
     * `createContext()` 用。`providerActions` 属于本仓「不支持」的 provider / 虚拟模型面，传了就抛。
     */
    bindCore(actions: ExtensionActions, contextActions: ExtensionContextActions, providerActions?: unknown): void;
    /** 已注册工具（含来源标签），保持注册顺序（Map 插入序）。 */
    getAllRegisteredTools(): RegisteredTool[];
    getToolDefinition(name: string): ToolDefinition | undefined;
    /** 某事件有没有订阅者（宿主据此决定要不要做前置工作；上游同名）。 */
    hasHandlers(eventType: string): boolean;
    /**
     * 装载扩展：跑完各扩展工厂（可 await）并收下工具与订阅。
     * 返回装载好的 `ExtensionAPI` 列表（宿主可直接调运行期成员）。
     *
     * `close()` 之后不再接受装载：runtime 已永久失效，再跑一次工厂会得到一个「注册期一切正常、
     * 运行期每个 ctx 都抛」的半活 runner，比直接报错更难查。
     */
    load(): Promise<Map<string, ExtensionAPI>>;
    /** 真正跑工厂的那段（只由 `load()` 的单飞槽调用）。 */
    private runLoad;
    /** 关掉宿主：作废 runtime（ctx 与事件总线订阅一并失效）并把相位落回 `loading`。 */
    close(): Promise<void>;
    /** 标记本扩展实例失效（上游同名；`session_shutdown` 之后由宿主调用）。 */
    invalidate(message?: string): void;
    /** 订阅扩展错误（照抄上游 `onError`）：每个 emit 捕获的 handler 异常都从这里出去。 */
    onError(listener: ExtensionErrorListener): () => void;
    emitError(error: ExtensionError): void;
    /** 给某个扩展用的 `ExtensionAPI` 实例（来源标签不同 ⇒ 报错与工具来源能定位到扩展）。 */
    apiFor(source: string): ExtensionAPI;
    /**
     * 扩展 handler 拿到的上下文（上游 `createContext`）。bindCore 之前调用 → 抛（照抄上游：没有注入的
     * 上下文动作就没有可兑现的成员）。每次调用新建一份，成员是惰性 getter，所以换模型/换信号立刻可见。
     */
    createContext(invocationSignal?: AbortSignal): ExtensionContext;
    /**
     * 通用 emit：逐订阅跑一遍 handler。`session_before_*` 收集返回值并在 `cancel` 时短路（上游同款：
     * 第一个要求取消的订阅说了算）。handler 抛错不外泄，走 `emitError`。
     */
    emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>>;
    /** 工具执行前：最后一个非空结果生效，`block` 立刻短路（上游同款）。handler 抛错直接冒泡给宿主。 */
    emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
    /** 工具执行后：把 handler 的改写合到一份结果上（换了 content 却没同时换 structuredContent 时丢弃后者）。 */
    emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined>;
    /**
     * 回合边界（`turn_end`）：handler 可以换草稿、决定是否继续；每次换完由宿主的 `buildContext` 重算上下文，
     * 重算抛错 → `valid: false`（草稿不可用，宿主据此回退）。
     */
    emitBoundary(baseEvent: BoundaryBaseEvent, buildContext: BoundaryContextBuilder): Promise<BoundaryDispatchResult>;
    /**
     * 每次 LLM 调用前的 `context` 变换（上游 `emitContext` 的第一相）：handler 只看不含 system 的会话，
     * 返回新列表或原地改都收；每轮之后把 prompt 与工具状态还原回头部（上游同款，system 消息归宿主所有）。
     */
    emitContext(messages: AgentMessage[]): Promise<AgentMessage[]>;
    /** `message_end`：替换定稿消息（角色必须一致，否则报错并忽略该次替换；上游同款）。 */
    emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined>;
    /** 每次 provider 请求前：handler 返回非 `undefined` 即整体替换载荷（后写覆盖先写）。 */
    emitBeforeProviderRequest(payload: unknown): Promise<unknown>;
    /** 请求头组装后：handler **原地改** `headers`（返回值被忽略），`null` 值表示删该头（上游同款）。 */
    emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders>;
    /**
     * agent 循环开始前：收 handler 追加的消息，并让后一个 handler 看到前一个的 system prompt 覆盖
     * （`systemPrompt` 由宿主注入的渲染函数给出——浏览器侧没有 system prompt 构造器，宿主才是它的所有者）。
     *
     * 只发**用户回合**那一支：pi-coding-agent 1.2.0 起 `before_agent_start` 按 `messageType` 分叉，
     * 另一支是 `pi.sendMessage(..., { triggerTurn: true })` 在空闲时起的自定义消息回合——本仓的循环由
     * 宿主从提交内容驱动，没有那条入口，所以恒发 `messageType: 'user'`。
     */
    emitBeforeAgentStart(prompt: string, images: ImageContent[] | undefined, systemPromptOptions: BuildSystemPromptOptions, renderSystemPrompt: SystemPromptRenderer): Promise<BeforeAgentStartCombinedResult>;
    /** 订阅事件总线（`pi.events.on` 的落点）。订阅交给 runtime 保管，`invalidate` 时统一退订。 */
    onEventBus(source: string, type: string, listener: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): () => void;
    /** 事件总线的生产面：宿主在对应时机把内部事件喂给 `pi.events` 的订阅者。 */
    emitEventBus(type: string, event: unknown): Promise<void>;
    private addTool;
    private onEvent;
    private push;
    /** 稳定快照（上游 `snapshotEventHandlers`：handler 可以在自己执行时退订/注册，不影响本轮）。 */
    private snapshot;
    private snapshotBus;
    /**
     * `close()` 之后的注册闸：`registerTool` / `on` 在加载期是合法的（不过相位门），但宿主已经关掉
     * runner 时再写进活表，就会出现「close 之后 `pi.on(...)` 静默成功、`emit` 仍分派给它」的半活状态
     * （与 `load()` 拒绝重载的理由自相矛盾）。`pi.events` 那条总线不需要这道闸——runtime 的
     * `trackEventBusSubscription` 在已失效时会立刻自退订。
     */
    private assertNotClosed;
    private isSessionBeforeEvent;
    private toError;
}
