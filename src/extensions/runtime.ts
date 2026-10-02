// src/extensions/runtime.ts —— 扩展运行时（P3 Task 18；上游 `ExtensionRuntime` 同名同形）。
//
// 出处：pi-coding-agent@1.0.0 `dist/core/extensions/types.d.ts:1551-1680`。
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

import type { Model, TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { CompactOptions, ExtensionContext } from './context';
import type { ToolInfo } from './api';

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
	sendUserMessage: (
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: 'steer' | 'followUp' },
	) => void;
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
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

const ACTION_NAMES = [
	'sendUserMessage', 'appendEntry', 'setSessionName', 'getSessionName', 'setLabel',
	'getActiveTools', 'getAllTools', 'setActiveTools', 'setModel', 'getThinkingLevel', 'setThinkingLevel',
] as const satisfies readonly (keyof ExtensionActions)[];

function notBound(name: string): () => never {
	return () => {
		throw new Error(`ExtensionRuntime：${name} 需要宿主先 bindCore（runner.bindCore(actions, contextActions)）`);
	};
}

/** 建一份动作全是抛错 stub 的运行时；`bindCore` 之后动作才生效。 */
export function createExtensionRuntime(): ExtensionRuntime {
	let active = true;
	let staleMessage: string | undefined;
	const subscriptions = new Set<() => void>();
	const stubs = Object.fromEntries(ACTION_NAMES.map((name) => [name, notBound(name)])) as unknown as ExtensionActions;
	return {
		...stubs,
		flagValues: new Map(),
		createContext: () => {
			throw new Error('ExtensionRuntime：createContext 需要宿主先 bindCore');
		},
		assertActive: () => {
			if (!active) throw new Error(staleMessage ?? 'ExtensionRuntime：该扩展实例已失效（invalidate 后不可再用）');
		},
		invalidate: (message?: string) => {
			if (!active) return;
			active = false;
			staleMessage = message;
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.clear();
		},
		trackEventBusSubscription: (unsubscribe: () => void) => {
			if (!active) {
				unsubscribe();
				return () => {};
			}
			subscriptions.add(unsubscribe);
			return () => {
				subscriptions.delete(unsubscribe);
			};
		},
	};
}

/** 把宿主动作拷进运行时（上游 `runner.initialize()` 的对应一步）。 */
export function bindCore(runtime: ExtensionRuntime, actions: ExtensionActions): void {
	Object.assign(runtime, actions);
}
