import { type ShellFsStore, type WasiFsChanges, type WasiFileSystem } from './wasi-fs.js';
export interface ShellSyncSession {
    /** 交给 wasi-sh `run()`/`spawn()` 的 store */
    guestFs: WasiFileSystem;
    /** run 前：挂载树 → guest 缓存 */
    seed(): Promise<void>;
    /** run 后：guest 变更集 → 挂载树 + flush */
    pullAndApply(): Promise<void>;
}
export declare function createSyncSession(store: ShellFsStore): ShellSyncSession;
/**
 * 把变更集写回宿主权威树 + flush（worker 路径拿到回传的变更集也走这里——两个方向共一份应用逻辑）。
 *
 * 失败**抛**（不吞）：回写失败意味着 guest 的写丢了，调用方（exec）要把它变成 `Result` 上的错误，
 * 而不是拿着「看起来成功」的运行结果继续。
 */
export declare function applyChanges(store: ShellFsStore, changes: WasiFsChanges): Promise<void>;
/** 按后端去重的 flush（默认表 '/' 是 IDB：超级块 500ms debounce；flush 契约见 BrowserFileSystem） */
export declare function flushMounts(store: ShellFsStore): Promise<void>;
