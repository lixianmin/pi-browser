// src/extensions/context.ts —— S6 spec §3.2/§3.3：交给 handler 的上下文（pi 同名，浏览器只给能兑现的子集）。
//
// 出处：@earendil-works/pi-coding-agent@0.85.1 `dist/core/extensions/types.d.ts`：
//   `cwd: string` / `model: Model<any> | undefined` / `isIdle(): boolean` / `signal: AbortSignal | undefined` /
//   `abort(): void` / `getContextUsage(): ContextUsage | undefined` / `compact(options?: CompactOptions): void`。
// 支持的 7 个成员之外，其余 10 个（`ui`/`mode`/`hasUI`/`sessionManager`/`modelRegistry`/`scopedModels`/
// `isProjectTrusted`/`hasPendingMessages`/`shutdown`/`getSystemPrompt`）列在 `contract.ts` 的
// `UNSUPPORTED_CONTEXT_MEMBERS`：本接口**刻意不声明**它们——声明了却不生效比不声明更糟。
//
// 两处已记录的形状差异（不发明替代物，逐条写在注释里）：
//   · `compact` 只接 `customInstructions`：pi 的 `onComplete`/`onError` 回调要它的 `CompactionResult` 类型，
//     浏览器侧没有同形类型。
//   · `ContextUsage` 是**照抄的数据形状**（pi 的原始定义在 CLI 仓，不在 pi-agent-core）。
import type { AgentLane, Context } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

/** 上下文用量（pi `ContextUsage` 逐字段照抄）。 */
export interface ContextUsage {
	/** 估算的上下文 token 数；未知时为 null（例如刚压缩完、还没下一次响应） */
	tokens: number | null;
	contextWindow: number;
	/** 占用百分比；tokens 未知时为 null */
	percent: number | null;
}

/** `compact()` 的选项（pi `CompactOptions` 的支持子集，理由见文件头）。 */
export interface CompactOptions {
	customInstructions?: string;
}

/**
 * 扩展 handler 拿到的上下文。**每个运行期调用由宿主动态构造**，注册期调用（扩展工厂里直接调）会在
 * `api.ts` 的相位门处响亮失败。
 *
 * 只有 5 个成员（同期裁决，spec §3.2.1）：上游的 `isIdle()` / `getContextUsage()` 是**同步值**，
 * 而 pi-agent-core 的对应操作是 `Promise`（`lane.inspectExecution` / 条目估算）——要支持就得让宿主
 * 另建缓存，本仓无用例，按 spec 规则收进「不支持」（不为了凑数而造一个假同步 API）。
 */
export interface ExtensionContext {
	/** 宿主工作目录（pi 语义：扩展用它拼路径） */
	readonly cwd: string;
	/** 当前模型；宿主未配置时为 undefined */
	readonly model: Model<any> | undefined;
	/** 应用侧停止信号（U13 教训：harness 不自动穿透，必须显式转发） */
	readonly signal: AbortSignal | undefined;
	/** 中止当前操作 */
	abort(): void;
	/** 压缩当前 lane 的上下文（异步进行，pi 的签名就是 void） */
	compact(options?: CompactOptions): void;
}

/** 构造 `ExtensionContext` 所需的宿主绑定。 */
export interface ExtensionContextBindings {
	cwd: string;
	model?: Model<any>;
	lane: AgentLane;
	context: Context;
	signal?: AbortSignal;
}

/** 构造一份上下文视图（同一次 run 内同一份引用）。失败一律 warn 不抛（上下文成员不能把回合搞崩）。 */
export function createExtensionContext(b: ExtensionContextBindings, invocationSignal?: AbortSignal): ExtensionContext {
	const warn = (what: string) => (e: unknown) =>
		console.warn(`[extensions] ctx.${what} 失败：${(e as Error)?.message ?? String(e)}`);
	return {
		cwd: b.cwd,
		model: b.model,
		signal: invocationSignal ?? b.signal,
		abort: () => { void b.lane.abort(b.context).catch(warn('abort')); },
		compact: (options) => {
			const opts = options?.customInstructions === undefined ? undefined : { customInstructions: options.customInstructions };
			void b.lane.compact(opts, b.context).catch(warn('compact'));
		},
	};
}
