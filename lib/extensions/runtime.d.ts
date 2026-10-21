import type { Model, TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { CompactOptions, ExtensionContext } from './context.js';
import type { ToolInfo } from './api.js';
/** 上游 `ExtensionRuntimeState` 的浏览器子集。 */
export interface ExtensionRuntimeState {
    flagValues: Map<string, boolean | string>;
    /** 建一份扩展上下文视图。bindCore 前调用 → 抛。 */
    createContext: () => ExtensionContext;
    /** 该扩展实例失效（invalidate / reload）后调用 → 抛。 */
    assertActive: () => void;
    /** 标记本扩展实例失效（可选消息进 assertActive 的报错）。 */
    invalidate: (message?: string) => void;
    /** 保留一个事件总线订阅，invalidate 时统一退订；返回取消函数。 */
    trackEventBusSubscription: (unsubscribe: () => void) => () => void;
}
/** 上游 `ExtensionActions` 的浏览器子集（成员签名逐字对齐 `types.d.ts:1519-1545`）。 */
export interface ExtensionActions {
    sendUserMessage: (content: string | (TextContent | ImageContent)[], options?: {
        deliverAs?: 'steer' | 'followUp';
    }) => void;
    appendEntry: <T = unknown>(customType: string, data?: T) => void;
    setSessionName: (name: string) => void;
    getSessionName: () => string | undefined;
    setLabel: (entryId: string, label: string | undefined) => void;
    getActiveTools: () => string[];
    getAllTools: () => ToolInfo[];
    setActiveTools: (toolNames: string[]) => void;
    setModel: (model: Model<any>) => Promise<boolean>;
    getThinkingLevel: () => ThinkingLevel;
    setThinkingLevel: (level: ThinkingLevel) => void;
}
/** 上游 `ExtensionContextActions` 的浏览器子集（只列本仓 `ExtensionContext` 兑现的 4 个）。 */
export interface ExtensionContextActions {
    getModel: () => Model<any> | undefined;
    getSignal: () => AbortSignal | undefined;
    abort: () => void;
    compact: (options?: CompactOptions) => void;
}
/** 上游 `ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions`。 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {
}
/** 建一份动作全是抛错 stub 的运行时；`bindCore` 之后动作才生效。 */
export declare function createExtensionRuntime(): ExtensionRuntime;
/** 把宿主动作拷进运行时（上游 `runner.initialize()` 的对应一步）。 */
export declare function bindCore(runtime: ExtensionRuntime, actions: ExtensionActions): void;
