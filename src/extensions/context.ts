// src/extensions/context.ts —— S6 spec §3.2/§3.3：交给 handler 的上下文（pi 同名，浏览器只给能兑现的子集）。
//
// 出处：@earendil-works/pi-coding-agent@1.0.0 `dist/core/extensions/types.d.ts:213`（`ExtensionContext`）
// 与 `runner.js:607`（`createContext()` 的实现体）。本文件只保留本仓兑现的 5 个成员：
//   `cwd` / `model` / `signal` / `abort()` / `compact(options?)`。
// 其余 13 个（`ui`/`mode`/`hasUI`/`sessionManager`/`modelRegistry`/`scopedModels`/`thinkingLevel`/`isIdle`/
// `isProjectTrusted`/`hasPendingMessages`/`shutdown`/`getContextUsage`/`getSystemPrompt`）列在 `contract.ts` 的
// `UNSUPPORTED_CONTEXT_MEMBERS`：本接口**刻意不声明**它们——声明了却不生效比不声明更糟。
//
// **取值全部来自注入**（P3，spec C11）：`cwd` 由 runner 构造期持有，`model`/`abort`/`compact` 来自宿主
// `bindCore` 注入的 `contextActions`，`signal` 优先取**本次工具调用**的信号（U13 教训：取消信号不自动穿透，
// 必须显式转发），缺省才问宿主的 `getSignal()`。每个成员都先过 `assertActive()`（上游逐字：实例失效后
// 不得再用拿到的 ctx）——用惰性 getter 而不是快照，所以 bindCore / 换信号之后同一个 ctx 读到的是新值。
//
// 两处已记录的形状差异（不发明替代物，逐条写在注释里）：
//   · `compact` 只接 `customInstructions`：pi 的 `onComplete`/`onError` 回调要它的 `CompactionResult` 类型，
//     浏览器侧没有同形类型。
//   · `ContextUsage` 是**照抄的数据形状**（pi 的原始定义在 CLI 仓，不在 pi-agent-core）。
import type { Model } from '@earendil-works/pi-ai';
import type { ExtensionContextActions } from './runtime';

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
 * `api.ts` 的相位门处响亮失败；`invalidate()` 之后读任何成员都抛。
 *
 * 只有 5 个成员（同期裁决，spec §3.2.1）：上游的 `isIdle()` / `getContextUsage()` 是**同步值**，
 * 而宿主侧的对应能力需要另行设计——要支持就得让宿主另建缓存，本仓无用例，按 spec 规则收进「不支持」
 * （不为了凑数而造一个假同步 API）。
 */
export interface ExtensionContext {
	/** 宿主工作目录（pi 语义：扩展用它拼路径） */
	readonly cwd: string;
	/** 当前模型；宿主未配置时为 undefined */
	readonly model: Model<any> | undefined;
	/** 本次调用的取消信号（本次工具调用的信号优先，缺省问宿主） */
	readonly signal: AbortSignal | undefined;
	/** 中止当前操作 */
	abort(): void;
	/** 压缩当前上下文（异步进行，pi 的签名就是 void） */
	compact(options?: CompactOptions): void;
}

/** 构造一份上下文视图所需的注入（runner 持有，扩展拿不到）。 */
export interface ExtensionContextOptions {
	/** runner 构造期的工作目录 */
	cwd: string;
	/** 宿主在 `bindCore` 注入的上下文动作（本仓兑现的 4 个） */
	contextActions: ExtensionContextActions;
	/** 实例有效性闸门（= `runtime.assertActive`） */
	assertActive: () => void;
	/** 本次工具调用/事件分派的信号（没有则问 `contextActions.getSignal()`） */
	invocationSignal?: AbortSignal;
}

/**
 * 构造一份上下文视图（照抄上游 `runner.createContext()` 的惰性 getter + `assertActive` 结构，
 * 成员按本仓的支持面裁剪）。同一次 run 内拿到的是同一份引用。
 */
export function createExtensionContext(options: ExtensionContextOptions): ExtensionContext {
	const { cwd, contextActions, assertActive } = options;
	return {
		get cwd() {
			assertActive();
			return cwd;
		},
		get model() {
			assertActive();
			return contextActions.getModel();
		},
		get signal() {
			assertActive();
			return options.invocationSignal ?? contextActions.getSignal();
		},
		abort: () => {
			assertActive();
			contextActions.abort();
		},
		compact: (compactOptions) => {
			assertActive();
			contextActions.compact(compactOptions);
		},
	};
}
