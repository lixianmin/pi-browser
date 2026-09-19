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
 * 扩展 handler 拿到的上下文。**每个运行期调用由宿主动态构造**（同一次 run 内同一份引用），
 * 注册期调用（扩展工厂里直接调）会响亮失败——见 `api.ts` 的 `assertActive`。
 */
export interface ExtensionContext {
	/** 宿主工作目录（pi 语义：扩展用它拼路径） */
	readonly cwd: string;
	/** 当前模型；宿主未配置时为 undefined */
	readonly model: Model<any> | undefined;
	/** 当前 lane 是否空闲（无在跑操作） */
	isIdle(): boolean;
	/** 应用侧停止信号（U13 教训：harness 不自动穿透，必须显式转发） */
	readonly signal: AbortSignal | undefined;
	/** 中止当前操作 */
	abort(): void;
	/** 上下文用量；算不出时为 undefined */
	getContextUsage(): ContextUsage | undefined;
	/** 压缩当前 lane 的上下文（异步进行，pi 的签名就是 void） */
	compact(options?: CompactOptions): void;
}
