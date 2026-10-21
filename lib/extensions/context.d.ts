import type { Model } from '@earendil-works/pi-ai';
import type { ExtensionContextActions } from './runtime.js';
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
export declare function createExtensionContext(options: ExtensionContextOptions): ExtensionContext;
