import { validateToolDefinition } from './tool.js';
/** 每个扩展一份 `ExtensionAPI`（来源标签不同 → 报错溯源与工具来源能定位到具体扩展）。 */
export function createExtensionAPI(runtime, hooks) {
    const call = (fn) => {
        hooks.assertActive(); // 相位门：注册期 / close 后调用运行期成员一律响亮失败
        return fn();
    };
    return {
        on(event, handler) {
            // 分派在 runner（它持有订阅表与错误上报）；这里只补类型：载荷由宿主经 emit 交付
            return hooks.onEvent(event, (e, ctx) => handler(e, ctx));
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
        sendUserMessage: (content, options) => call(() => runtime.sendUserMessage(content, options)),
        setSessionName: (name) => call(() => runtime.setSessionName(name)),
        getSessionName: () => call(() => runtime.getSessionName()),
        setLabel: (entryId, label) => call(() => runtime.setLabel(entryId, label)),
        // 刻意**不写 async**：相位门要在调用处同步抛（扩展工厂里不 await 时，async 会把 throw 包成
        // rejection → unhandled rejection，闸门等于失效）。返回值仍是 Promise<boolean>，类型不变。
        setModel: (model) => {
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
