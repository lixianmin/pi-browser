import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { SUPPORTED_EVENTS, UNSUPPORTED_EVENTS } from './contract.js';
import { createExtensionAPI } from './api.js';
import { createExtensionContext } from './context.js';
import { bindCore } from './runtime.js';
import { logger } from '../logging.js';
/**
 * 宿主：装载扩展 → 收工具与事件订阅 → 交给宿主消费。
 * `load()` 跑完工厂后进入 `active` 相位；此前扩展工厂里调用运行期成员会**响亮抛错**（对齐 pi 的
 * `assertActive()` 与 loader 的抛错 stub 两道闸）。
 */
export class ExtensionRunner {
    extensions;
    runtime;
    cwd;
    handlers = new Map();
    eventBus = new Map();
    registered = new Map();
    apiPerSource = new Map();
    errorListeners = new Set();
    phase = 'loading';
    closed = false;
    /** 单飞槽：并发的 `load()` 共用同一次装载（否则两次都清表再各注册一遍 → handler 跑两遍） */
    loading;
    contextActions;
    constructor(extensions, runtime, cwd) {
        this.extensions = extensions;
        this.runtime = runtime;
        this.cwd = cwd;
    }
    /**
     * 注入宿主能力（上游 `bindCore` 的对应一步）：动作拷进共享 runtime，上下文动作留在 runner 里给
     * `createContext()` 用。`providerActions` 属于本仓「不支持」的 provider / 虚拟模型面，传了就抛。
     */
    bindCore(actions, contextActions, providerActions) {
        if (providerActions !== undefined) {
            throw new Error('ExtensionRunner：providerActions 属于不支持面（provider / 虚拟模型注册），本仓不实现');
        }
        bindCore(this.runtime, actions);
        this.contextActions = contextActions;
        this.runtime.createContext = () => this.createContext();
    }
    /** 已注册工具（含来源标签），保持注册顺序（Map 插入序）。 */
    getAllRegisteredTools() {
        return [...this.registered.values()];
    }
    getToolDefinition(name) {
        return this.registered.get(name)?.definition;
    }
    /** 某事件有没有订阅者（宿主据此决定要不要做前置工作；上游同名）。 */
    hasHandlers(eventType) {
        const handlers = this.handlers.get(eventType);
        return handlers !== undefined && handlers.length > 0;
    }
    /**
     * 装载扩展：跑完各扩展工厂（可 await）并收下工具与订阅。
     * 返回装载好的 `ExtensionAPI` 列表（宿主可直接调运行期成员）。
     *
     * `close()` 之后不再接受装载：runtime 已永久失效，再跑一次工厂会得到一个「注册期一切正常、
     * 运行期每个 ctx 都抛」的半活 runner，比直接报错更难查。
     */
    async load() {
        if (this.closed) {
            throw new Error('ExtensionRunner：宿主已 close，不能再 load（要重新装载请新建 runner + runtime）');
        }
        if (this.loading)
            return this.loading;
        this.loading = this.runLoad();
        try {
            return await this.loading;
        }
        finally {
            this.loading = undefined;
        }
    }
    /** 真正跑工厂的那段（只由 `load()` 的单飞槽调用）。 */
    async runLoad() {
        // 每次装载都从干净的三张表开始：工厂中途抛错时已注册的工具与订阅不会撤销，宿主 catch 后
        // 重试 load() 会让同一个 handler 跑两遍（对有副作用的 handler 就是双写）。上游的 loader 在
        // runner 诞生**之前**就跑完工厂，所以它没有这个失败模式；我们的 load() 自己跑工厂，就得自己兜。
        this.registered.clear();
        this.handlers.clear();
        this.eventBus.clear();
        this.phase = 'loading';
        let anonymous = 0;
        for (const ext of this.extensions) {
            const named = typeof ext === 'function' ? undefined : ext;
            const factory = typeof ext === 'function' ? ext : ext.factory;
            const source = named?.name ?? `<anonymous:${++anonymous}>`;
            await factory(this.apiFor(source));
        }
        // 装载期间宿主调了 close()：不要把已关闭的 runner 又标回 active
        if (!this.closed)
            this.phase = 'active';
        return this.apiPerSource;
    }
    /** 关掉宿主：作废 runtime（ctx 与事件总线订阅一并失效）并把相位落回 `loading`。 */
    async close() {
        this.closed = true;
        this.runtime.invalidate('ExtensionRunner：宿主已 close，拿到的 ctx 与订阅不可再用');
        this.phase = 'loading';
    }
    /** 标记本扩展实例失效（上游同名；`session_shutdown` 之后由宿主调用）。 */
    invalidate(message) {
        this.runtime.invalidate(message);
    }
    /** 订阅扩展错误（照抄上游 `onError`）：每个 emit 捕获的 handler 异常都从这里出去。 */
    onError(listener) {
        this.errorListeners.add(listener);
        return () => this.errorListeners.delete(listener);
    }
    emitError(error) {
        // `emitError` 总是在 `catch` 块里被调用：listener 自己再抛，就会把「已捕获的扩展错误」变成
        // 打断 agent 轮次的抛出，并让后续 listener 收不到（上游这里不设防，我们补一道）。
        for (const listener of this.errorListeners) {
            try {
                listener(error);
            }
            catch (err) {
                logger.warn('[extensions] onError listener 自身抛错', { detail: errText(err) });
            }
        }
    }
    /** 给某个扩展用的 `ExtensionAPI` 实例（来源标签不同 ⇒ 报错与工具来源能定位到扩展）。 */
    apiFor(source) {
        const existing = this.apiPerSource.get(source);
        if (existing)
            return existing;
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
    createContext(invocationSignal) {
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
    async emit(event) {
        const ctx = this.createContext();
        let result;
        for (const { path, handler } of this.snapshot(event.type)) {
            try {
                const handlerResult = await handler(event, ctx);
                if (this.isSessionBeforeEvent(event) && handlerResult) {
                    result = handlerResult;
                    if (result.cancel)
                        return result;
                }
            }
            catch (err) {
                this.emitError(this.toError(path, event.type, err));
            }
        }
        return result;
    }
    /** 工具执行前：最后一个非空结果生效，`block` 立刻短路（上游同款）。handler 抛错直接冒泡给宿主。 */
    async emitToolCall(event) {
        const ctx = this.createContext();
        let result;
        for (const { handler } of this.snapshot('tool_call')) {
            const handlerResult = await handler(event, ctx);
            if (handlerResult) {
                result = handlerResult;
                if (result.block)
                    return result;
            }
        }
        return result;
    }
    /** 工具执行后：把 handler 的改写合到一份结果上（换了 content 却没同时换 structuredContent 时丢弃后者）。 */
    async emitToolResult(event) {
        const ctx = this.createContext();
        const currentEvent = { ...event };
        let modified = false;
        for (const { path, handler } of this.snapshot('tool_result')) {
            try {
                const handlerResult = await handler(currentEvent, ctx);
                if (!handlerResult)
                    continue;
                if (handlerResult.content !== undefined) {
                    currentEvent.content = handlerResult.content;
                    // Structured content that is not replaced along with the content may no longer match it.
                    if (handlerResult.structuredContent === undefined)
                        delete currentEvent.structuredContent;
                    modified = true;
                }
                // `details` 逐分支而异（bash 有 details、write 是 undefined），统一按 unknown 读写
                if (handlerResult.details !== undefined) {
                    currentEvent.details = handlerResult.details;
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
            }
            catch (err) {
                this.emitError(this.toError(path, 'tool_result', err));
            }
        }
        if (!modified)
            return undefined;
        return {
            content: currentEvent.content,
            details: currentEvent.details,
            structuredContent: currentEvent.structuredContent,
            isError: currentEvent.isError,
            usage: currentEvent.usage,
        };
    }
    /**
     * 回合边界（`turn_end`）：handler 可以换草稿、决定是否继续；每次换完由宿主的 `buildContext` 重算上下文，
     * 重算抛错 → `valid: false`（草稿不可用，宿主据此回退）。
     */
    async emitBoundary(baseEvent, buildContext) {
        const ctx = this.createContext();
        let entries = [];
        let shouldContinue = false;
        let context = await buildContext(entries);
        let valid = true;
        for (const { path, handler } of this.snapshot(baseEvent.type)) {
            try {
                const event = { ...baseEvent, entries, continue: shouldContinue, context };
                const handlerResult = await handler(event, ctx);
                if (handlerResult?.entries !== undefined)
                    entries = handlerResult.entries;
                if (handlerResult?.continue !== undefined)
                    shouldContinue = handlerResult.continue;
            }
            catch (err) {
                this.emitError(this.toError(path, baseEvent.type, err));
            }
            try {
                context = await buildContext(entries);
                valid = true;
            }
            catch (err) {
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
    async emitContext(messages) {
        const ctx = this.createContext();
        // 上游用 structuredClone（有意：handler 拿到的是快照，改它不污染宿主那份）。但深拷贝一旦遇到
        // 不可结构化克隆的对象就会抛，而这里在 try 之外 —— 异常会直接打断轮次，绕过了「handler 异常走
        // emitError」的整体承诺。降级为浅拷贝并报错（不静默：走的是 onError 那条路）。
        let currentMessages;
        try {
            currentMessages = structuredClone(messages);
        }
        catch (err) {
            this.emitError(this.toError('<runtime>', 'context', new Error(`消息列表无法深拷贝，已降级为浅拷贝：${errText(err)}`)));
            // 数组与元素都要拷：只 slice() 的话，handler 走「原地改 event.messages[i]」那条路（emitContext
            // 明确支持）会改到宿主自己的消息对象上，并顺着引用流回会话。
            currentMessages = messages.map((m) => ({ ...m }));
        }
        for (const { path, handler } of this.snapshot('context')) {
            try {
                const visibleMessages = currentMessages.filter((message) => message.role !== 'system');
                const visibleSnapshot = visibleMessages.slice();
                const event = { type: 'context', messages: visibleMessages };
                const handlerResult = await handler(event, ctx);
                // Handlers may return a new list or edit event.messages in place.
                const returned = handlerResult?.messages
                    ?? (sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
                if (!returned)
                    continue;
                currentMessages = restoreSystemMessages(currentMessages, visibleSnapshot, returned);
            }
            catch (err) {
                this.emitError(this.toError(path, 'context', err));
            }
        }
        return currentMessages;
    }
    /** `message_end`：替换定稿消息（角色必须一致，否则报错并忽略该次替换；上游同款）。 */
    async emitMessageEnd(event) {
        const ctx = this.createContext();
        let currentMessage = event.message;
        let modified = false;
        for (const { path, handler } of this.snapshot('message_end')) {
            try {
                const currentEvent = { ...event, message: currentMessage };
                const handlerResult = await handler(currentEvent, ctx);
                if (!handlerResult?.message)
                    continue;
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
            }
            catch (err) {
                this.emitError(this.toError(path, 'message_end', err));
            }
        }
        return modified ? currentMessage : undefined;
    }
    /** 每次 provider 请求前：handler 返回非 `undefined` 即整体替换载荷（后写覆盖先写）。 */
    async emitBeforeProviderRequest(payload) {
        const ctx = this.createContext();
        let currentPayload = payload;
        for (const { path, handler } of this.snapshot('before_provider_request')) {
            try {
                const event = { type: 'before_provider_request', payload: currentPayload };
                const handlerResult = await handler(event, ctx);
                if (handlerResult !== undefined)
                    currentPayload = handlerResult;
            }
            catch (err) {
                this.emitError(this.toError(path, 'before_provider_request', err));
            }
        }
        return currentPayload;
    }
    /** 请求头组装后：handler **原地改** `headers`（返回值被忽略），`null` 值表示删该头（上游同款）。 */
    async emitBeforeProviderHeaders(headers) {
        const ctx = this.createContext();
        for (const { path, handler } of this.snapshot('before_provider_headers')) {
            try {
                const event = { type: 'before_provider_headers', headers };
                await handler(event, ctx);
            }
            catch (err) {
                this.emitError(this.toError(path, 'before_provider_headers', err));
            }
        }
        return headers;
    }
    /**
     * agent 循环开始前：收 handler 追加的消息，并让后一个 handler 看到前一个的 system prompt 覆盖
     * （`systemPrompt` 由宿主注入的渲染函数给出——浏览器侧没有 system prompt 构造器，宿主才是它的所有者）。
     *
     * 只发**用户回合**那一支：pi-coding-agent 1.2.0 起 `before_agent_start` 按 `messageType` 分叉，
     * 另一支是 `pi.sendMessage(..., { triggerTurn: true })` 在空闲时起的自定义消息回合——本仓的循环由
     * 宿主从提交内容驱动，没有那条入口，所以恒发 `messageType: 'user'`。
     */
    async emitBeforeAgentStart(prompt, images, systemPromptOptions, renderSystemPrompt) {
        const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);
        const messages = [];
        const ctx = this.createContext();
        for (const { path, handler } of this.snapshot('before_agent_start')) {
            try {
                const event = {
                    type: 'before_agent_start',
                    messageType: 'user',
                    prompt,
                    images,
                    get systemPrompt() {
                        return renderSystemPrompt(currentOptions);
                    },
                    systemPromptOptions: currentOptions,
                };
                const handlerResult = await handler(event, ctx);
                if (!handlerResult)
                    continue;
                if (handlerResult.message)
                    messages.push(handlerResult.message);
                if (handlerResult.systemPrompt !== undefined) {
                    currentOptions.forceSystemPrompt = handlerResult.systemPrompt;
                }
            }
            catch (err) {
                this.emitError(this.toError(path, 'before_agent_start', err));
            }
        }
        return { messages, systemPromptOptions: currentOptions };
    }
    // ———— `pi.events` 事件总线（订阅面在扩展上，生产面在宿主上）————
    /** 订阅事件总线（`pi.events.on` 的落点）。订阅交给 runtime 保管，`invalidate` 时统一退订。 */
    onEventBus(source, type, listener) {
        const unsubscribe = this.push(this.eventBus, type, {
            path: `<extension:${source}>`,
            handler: (event, ctx) => listener(event, ctx),
        });
        return this.runtime.trackEventBusSubscription(unsubscribe);
    }
    /** 事件总线的生产面：宿主在对应时机把内部事件喂给 `pi.events` 的订阅者。 */
    async emitEventBus(type, event) {
        const ctx = this.createContext();
        for (const { path, handler } of this.snapshotBus(type)) {
            try {
                await handler(event, ctx);
            }
            catch (err) {
                this.emitError(this.toError(path, type, err));
            }
        }
    }
    // ———— 内部 ————
    addTool(definition, source) {
        this.assertNotClosed(source, 'registerTool');
        const previous = this.registered.get(definition.name);
        if (previous) {
            // 对齐 pi 宿主语义（Map.set：后写覆盖先写），差异只有这一行告警 —— spec §3.5
            logger.warn('[extensions] 工具重名', {
                tool: definition.name,
                previous: previous.sourceInfo.source,
                current: source,
            });
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
    onEvent(source, event, handler) {
        this.assertNotClosed(source, 'on');
        if (!(event in SUPPORTED_EVENTS)) {
            throw new Error(`扩展 "${source}"：on("${event}") 不支持（`
                + `${UNSUPPORTED_EVENTS.includes(event) ? '该事件在浏览器侧无对应物' : '未知事件名'}）。`
                + `支持：${Object.keys(SUPPORTED_EVENTS).join(', ')}`);
        }
        return this.push(this.handlers, event, { path: `<extension:${source}>`, handler });
    }
    push(table, key, subscription) {
        const list = table.get(key);
        if (list)
            list.push(subscription);
        else
            table.set(key, [subscription]);
        return () => {
            const current = table.get(key);
            if (!current)
                return;
            const index = current.indexOf(subscription);
            if (index >= 0)
                current.splice(index, 1);
        };
    }
    /** 稳定快照（上游 `snapshotEventHandlers`：handler 可以在自己执行时退订/注册，不影响本轮）。 */
    snapshot(event) {
        return (this.handlers.get(event) ?? []).slice();
    }
    snapshotBus(event) {
        return (this.eventBus.get(event) ?? []).slice();
    }
    /**
     * `close()` 之后的注册闸：`registerTool` / `on` 在加载期是合法的（不过相位门），但宿主已经关掉
     * runner 时再写进活表，就会出现「close 之后 `pi.on(...)` 静默成功、`emit` 仍分派给它」的半活状态
     * （与 `load()` 拒绝重载的理由自相矛盾）。`pi.events` 那条总线不需要这道闸——runtime 的
     * `trackEventBusSubscription` 在已失效时会立刻自退订。
     */
    assertNotClosed(source, what) {
        // 闸要跟 runtime 的生死一致：`invalidate()` 不会置 `closed`，只看 `closed` 时失效扩展仍能
        // 往活表里写工具/订阅（api.ts 明说 close()/invalidate() 之后都要响亮失败）。
        try {
            this.runtime.assertActive();
        }
        catch (e) {
            throw new Error(`扩展 "${source}"：宿主已 close / invalidate，不能再 ${what}（${e.message}）`);
        }
    }
    isSessionBeforeEvent(event) {
        return event.type === 'session_before_switch'
            || event.type === 'session_before_fork'
            || event.type === 'session_before_compact'
            || event.type === 'session_before_tree';
    }
    toError(extensionPath, event, err) {
        return {
            extensionPath,
            event,
            error: errText(err),
            stack: err instanceof Error ? err.stack : undefined,
        };
    }
}
const errText = (err) => (err instanceof Error ? err.message : String(err));
/** 上游 `runner.js:90`（同数组同引用即视为未改）。 */
function sameMessages(left, right) {
    return left.length === right.length && left.every((message, index) => message === right[index]);
}
/**
 * Re-attach the prompt and tool state after a `context` handler（上游 `runner.js:101` 逐字）。
 * 未改动的会话保留全部 system 消息原位；改动过的把重放后的 prompt 与工具声明作为一条头部 system 消息补回，
 * 这样裁剪/开窗/压缩切片都不会把 prompt 丢掉。
 */
function restoreSystemMessages(current, visible, returned) {
    if (sameMessages(returned, visible))
        return current;
    const head = getCurrentSystemMessage(current);
    return head ? [head, ...returned] : returned;
}
function normalizeBuildSystemPromptOptions(input) {
    // 上游 `core/system-prompt.js:9-23` 逐字（含两点**不能省**的语义）：
    //   ① `selectedTools` 缺省是四个核心工具 —— 缺省给 `[]` 会让宿主渲染出的 system prompt 少掉
    //      它们的规则段（静默给错结果，不是形状问题）；
    //   ② 每个集合字段都**拷贝**（上游注释：「the mutable, collection-complete shape exposed to
    //      extensions」）—— 按引用的话，扩展一句 `options.skills.push(...)` 就改到了宿主自己的对象
    //      并跨轮次残留。
    return {
        customPrompt: input.customPrompt,
        forceSystemPrompt: input.forceSystemPrompt,
        selectedTools: [...(input.selectedTools ?? ['read', 'bash', 'edit', 'write'])],
        // 上游 1.0.3 新增：`prepareLoadout` 把声明藏起来的工具（只能经别的工具到达），缺省空集
        hiddenTools: [...(input.hiddenTools ?? [])],
        toolSnippets: { ...(input.toolSnippets ?? {}) },
        toolGuidelines: Object.fromEntries(Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]])),
        promptGuidelines: [...(input.promptGuidelines ?? [])],
        appendSystemPrompt: input.appendSystemPrompt ?? '',
        sections: { ...(input.sections ?? {}) },
        cwd: input.cwd,
        contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
        skills: (input.skills ?? []).map((skill) => ({ ...skill })),
    };
}
