// src/env/context.ts —— chord `Context` 的全仓唯一入口。
//
// 出处：@earendil-works/chord@1.0.0 `dist/context/index.d.ts`。
// 上游 1.0.0 把 `Context` / `BACKGROUND_CONTEXT` 从 pi-agent-core 的 harness 移回 chord 本体
// （pi-agent-core@0.99.1 只是 re-export）。收成单点：上游再搬时只改这一处，
// 且避免一份代码同时从两个包取同一个类型。
export { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
// 注意：`Context` 由 chord 的**根**入口导出；`chord/context` 子路径只 import type 自用，不 re-export
export type { Context } from '@earendil-works/chord';
