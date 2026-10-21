/**
 * 构造一份上下文视图（照抄上游 `runner.createContext()` 的惰性 getter + `assertActive` 结构，
 * 成员按本仓的支持面裁剪）。同一次 run 内拿到的是同一份引用。
 */
export function createExtensionContext(options) {
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
