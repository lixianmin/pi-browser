export interface AtomicsWithWaitAsync {
    waitAsync(typedArray: Int32Array, index: number, value: number, timeout?: number): {
        async: boolean;
        value: unknown;
    };
}
/** 带 `waitAsync` 的 Atomics 视图（类型补丁，运行时就是全局 `Atomics`） */
export declare const atomics: typeof Atomics & AtomicsWithWaitAsync;
