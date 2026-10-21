import type { ExecutionEnv } from './types.js';
import type { WasmSource } from 'wasi-sh';
import type { MountEntry } from './types.js';
import { type HostCommandRegistry } from '../shell/host-commands.js';
export interface BrowserExecutionEnvOptions {
    /** IndexedDB 库名（默认挂载 '/' 用）；默认 'spice-sessions'（沿用以减少漂移面，见 BrowserFileSystemOptions） */
    dbName?: string;
    /** 覆盖默认挂载表（宿主注册其它 backend 的缝；本库不内置 backend-fsa） */
    mounts?: MountEntry[];
    /** shell backend：默认 'busybox'（wasi-sh busybox ash）；`false` 保持 S1 的占位（exec 恒 shell_unavailable） */
    shell?: 'busybox' | false;
    /** 浏览器下的 worker 模块 URL（打包器产物）；node/vitest 走 inline 路径，不需要（见 BusyboxShellOptions） */
    workerUrl?: URL | string;
    /** busybox wasm（默认本包自带的 src/shell/busybox.wasm；见 BusyboxShellOptions.wasm） */
    wasm?: WasmSource;
    /**
     * 宿主命令（S2.1 §3.3）：名字 → 主线程处理器；与 applet/内建同名会在创建时抛错。
     * inline 路径只支持同步纯处理器（无第二线程可停靠）；异步或有 FS 效果的处理器只在 worker 路径可用。
     */
    hostCommands?: HostCommandRegistry;
}
export declare function createBrowserExecutionEnv(o?: BrowserExecutionEnvOptions): ExecutionEnv;
