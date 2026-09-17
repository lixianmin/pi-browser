// `Atomics.waitAsync` 属 ES2024 lib，但运行时自 Chrome 87 / Node 16.4 起可用。
// 本仓以**源码**形式被消费者编译（spice 直接编译 node_modules/@lixianmin/pi-browser/src），
// 不能要求消费者把 lib 提到 ES2024（实测 spice apps/web 用 ES2022 → TS2550）。
// 故在此做最小本地收口：只声明我们用到的那一面，不改全局（避免与 ES2024 消费者的类型重复）。
export interface AtomicsWithWaitAsync {
	waitAsync(typedArray: Int32Array, index: number, value: number, timeout?: number): { async: boolean; value: unknown };
}

/** 带 `waitAsync` 的 Atomics 视图（类型补丁，运行时就是全局 `Atomics`） */
export const atomics = Atomics as unknown as typeof Atomics & AtomicsWithWaitAsync;
