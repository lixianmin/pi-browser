import { type FileSystem } from 'wasi-sh/fs';
import type { MountEntry } from '../env/types.js';
/**
 * 适配器的注入面：宿主权威树。seed 把它的当前内容读进缓存，pull 把变更写回它；
 * 路由复用 S1 的 MountTable（归一先行 / 段边界 / 最长前缀），不在这里重写一套前缀匹配。
 */
export interface ShellFsStore {
    mounts: MountEntry[];
}
/**
 * 一个 run 边界要过界的变更集（sync-session 应用；worker 侧回传同形状）。
 *
 * 三段的**应用顺序就是数组顺序**：先 deleted（含「类型变了」的路径：文件↔目录，先删旧节点），
 * 再 dirs（父先于子），最后 written（全量字节）。顺序是契约的一部分——乱序会出现
 * 「往还存在的旧目录上写文件」这类 EISDIR。
 */
export interface WasiFsChanges {
    /** run 期间消失的路径，以及类型变了的路径；目录只报最上层（宿主 rm -r 连带整棵子树） */
    deleted: string[];
    /** 新建的目录（父先于子） */
    dirs: string[];
    /** 新建/内容变化的文件（全量字节） */
    written: {
        path: string;
        data: Uint8Array;
    }[];
}
/**
 * worker（`src/shell/worker.ts`）与主线程（exec 的 worker 路径）之间的拉取协议。
 * 常量住这里而不是 worker.ts：worker 模块 import 时会执行 `serve()`，主线程不能 import 它。
 */
export declare const PULL_CHANGES = "pi-browser:pull-changes";
/**
 * 主线程 → worker：把宿主的目录列表（含**空目录**）在 spawn 前交给 guest。
 * spawn 的 `files` 只表达文件，wasi-sh 只建文件的父目录；不补这条消息，空目录在 guest 里从不存在，
 * 收尾对账会把它算成「已删除」并从宿主递归删掉（静默数据丢失）。
 */
export declare const PUSH_DIRS = "pi-browser:push-dirs";
export interface PullChangesRequest {
    type: typeof PULL_CHANGES;
}
export interface PushDirsRequest {
    type: typeof PUSH_DIRS;
    dirs: string[];
}
export interface ChangesResponse {
    type: 'pi-browser:changes';
    changes: WasiFsChanges;
}
export interface WasiFileSystem extends FileSystem {
    /** 把挂载树读进同步缓存（清空后重载），并把读到的树设为变更基线；run 前调用一次 */
    seed(): Promise<void>;
    /** 自上次 seed/exportChanges/applyChanges 起的差异（**drain**：导出即把当前树立为新基线，不会重复回写） */
    exportChanges(): WasiFsChanges;
    /**
     * 当前全树（`deleted` 恒空），**不动 drain 基线**。
     *
     * 用途是 exec 收尾的拉取（worker 的 `PULL_CHANGES`）：那次对账要的是「guest 现在到底有什么」，
     * 而 drain 给的只是「自上次 drain 起的差」——run 中间跑过宿主命令（builtin 会 drain 一次），
     * 收尾那次 drain 就是空差集，宿主侧会把推出去的树当成全删了（实测事故，见 test/worker-pull.test.ts）。
     */
    snapshot(): WasiFsChanges;
    /**
     * 宿主侧变更集 → 缓存（宿主命令返回后的对账，S2.1 §3.3 第 ③ 步），并把基线重置到落盘后的树。
     *
     * 同步是必需的：调用它的是 wasi-sh 的同步 builtin（guest 是同步 wasm 帧，没有可 await 的地方）。
     * 基线必须一起重置：否则宿主自己的写会在下一次 exportChanges 里被当成 guest 的变更再回传一遍。
     */
    applyChanges(changes: WasiFsChanges): void;
}
export declare const bytesEqual: (a: Uint8Array, b: Uint8Array) => boolean;
/**
 * 把挂载树读成变更集形状（`deleted` 恒空）。两个真实调用方：适配器的 `seed()`，以及 exec 的
 * worker 路径（整树经 spawn 的 `files` 推给 worker——活着的 guest 钳住线程，postMessage 进不去）。
 */
export declare function readMountTree(store: ShellFsStore): Promise<WasiFsChanges>;
export declare function createWasiFileSystem(store: ShellFsStore): WasiFileSystem;
