// src/extensions/runtime.ts —— 扩展运行时（P3 Task 18；上游 `ExtensionRuntime` 同名同形）。
//
// 出处：pi-coding-agent@1.0.2 `dist/core/extensions/types.d.ts:1559-1688`。
// 上游 loader 建一份「动作全是抛错 stub」的 runtime，runner 在 `bindCore` 时把真动作拷进去。
//
// 浏览器子集（spec C11/F16；不造 stub 顶替不支持面）：
//   · `ExtensionRuntimeState`：只实现 `flagValues` / `createContext` / `assertActive` / `invalidate` /
//     `trackEventBusSubscription`；provider / MCP / 虚拟模型三组字段**不声明**（它们的类型住在 CLI 仓、
//     本仓也没有对应的运行能力）。
//   · `ExtensionActions`：只声明 S6 支持面用得到的 11 个 handler（`sendMessage` / `getSettings` /
//     `refreshTools` / `getCommands` 不声明：本仓 `ExtensionAPI` 不暴露这四个成员）。
//   · `ExtensionContextActions`：只声明本仓 `ExtensionContext` 兑现的 4 个（getModel / getSignal / abort /
//     compact）；`getSystemPrompt` / `executeTool` 等引用 CLI 仓类型或未支持面，不声明。
// `createContext` 由 runner（持 `contextActions`）在 bindCore 时赋值；bindCore 前调用一律响亮抛错。
const ACTION_NAMES = [
    'sendUserMessage', 'appendEntry', 'setSessionName', 'getSessionName', 'setLabel',
    'getActiveTools', 'getAllTools', 'setActiveTools', 'setModel', 'getThinkingLevel', 'setThinkingLevel',
];
function notBound(name) {
    return () => {
        throw new Error(`ExtensionRuntime：${name} 需要宿主先 bindCore（runner.bindCore(actions, contextActions)）`);
    };
}
/** 建一份动作全是抛错 stub 的运行时；`bindCore` 之后动作才生效。 */
export function createExtensionRuntime() {
    let active = true;
    let staleMessage;
    const subscriptions = new Set();
    const stubs = Object.fromEntries(ACTION_NAMES.map((name) => [name, notBound(name)]));
    return {
        ...stubs,
        flagValues: new Map(),
        createContext: () => {
            throw new Error('ExtensionRuntime：createContext 需要宿主先 bindCore');
        },
        assertActive: () => {
            if (!active)
                throw new Error(staleMessage ?? 'ExtensionRuntime：该扩展实例已失效（invalidate 后不可再用）');
        },
        invalidate: (message) => {
            if (!active)
                return;
            active = false;
            staleMessage = message;
            for (const unsubscribe of subscriptions)
                unsubscribe();
            subscriptions.clear();
        },
        trackEventBusSubscription: (unsubscribe) => {
            if (!active) {
                unsubscribe();
                return () => { };
            }
            // 返回的取消函数必须**真的退订**（上游同款）。旧实现只把订阅从跟踪表里摘掉，
            // `pi.events.on` 的 handler 仍然活着，且 invalidate 也再也管不到它。
            const cancel = () => {
                if (!subscriptions.delete(cancel))
                    return; // 幂等：invalidate 之后不再重复调用
                unsubscribe();
            };
            subscriptions.add(cancel);
            return cancel;
        },
    };
}
/** 把宿主动作拷进运行时（上游 `runner.initialize()` 的对应一步）。 */
export function bindCore(runtime, actions) {
    Object.assign(runtime, actions);
}
