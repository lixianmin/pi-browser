// src/env/context.ts —— chord `Context` 的全仓唯一入口。
//
// 出处：@earendil-works/chord@1.0.2 `dist/context/index.d.ts`。
// 上游 1.0.0 把 `Context` / `BACKGROUND_CONTEXT` 从 pi-agent-core 的 harness 移回 chord 本体
// （pi-agent-core@0.99.1 只是 re-export）。收成单点：上游再搬时只改这一处，
// 且避免一份代码同时从两个包取同一个类型。
export { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { FileError, err } from '@earendil-works/pi-durable/env';
/**
 * 上游同款**入口** abort 检查（`NodeExecutionEnv` 用 `abortResult(context.abortSignal)`）。
 *
 * 为什么需要（修正 spec §11 原裁决「context 只接不用」）：那个裁决的前提是「浏览器后端无异步 IO
 * 可中断」——它只对**中断已发起的操作**成立（lightning-fs 的 IndexedDB 请求确实没有 cancel 面），
 * 但入口检查是另一回事：已取消的调用不应**发起新操作**。`writeFile` 在取消后仍写盘、`remove` 在
 * 取消后仍删文件，都是可观察的错误行为（tool 被用户 cancel 了，文件却已经被改）。
 *
 * 与上游的差别：上游在长循环里额外检查（如 `scanLines` 每读一块），本仓两个后端都把整份内容
 * 一次性读入内存，没有可中断的长循环。
 *
 * 返回 `undefined` 表示未取消，调用方继续；返回 `Result` 表示已取消，直接当成方法结果返回。
 */
export function abortedResult(context, path) {
    return context.abortSignal?.aborted
        ? err(new FileError('aborted', 'Aborted', path))
        : undefined;
}
