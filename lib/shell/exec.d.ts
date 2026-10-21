import type { Shell } from '../env/types.js';
import { type WasmSource } from 'wasi-sh';
import { type HostCommandRegistry } from './host-commands.js';
import { type ShellFsStore, type WasiFsChanges } from './wasi-fs.js';
export interface BusyboxShellOptions {
    /**
     * 浏览器 worker 模块 URL（宿主打包器产物，形如
     * `new Worker(new URL('@lixianmin/pi-browser/shell/worker', import.meta.url), { type: 'module' })`）。
     * 浏览器下必须给：fs 是活对象、不能结构化克隆进 worker，只能由自建 worker 模块 `serve({fs})` 注册。
     */
    workerUrl?: URL | string;
    /**
     * busybox wasm（URL / 字节 / 已编译模块）。默认用本包自带的 `./busybox.wasm`——
     * 它比上游 wasi-sh 自带的那份多了 find 的 -path/-maxdepth/-mtime/-size 等选项、SHOW_USAGE
     * （否则 `--help` 静默 exit 0）与一批常用 applet；来源与重建方式见 `scripts/build-busybox.sh`。
     */
    wasm?: WasmSource;
    /**
     * 宿主命令（S2.1 §3）：名字 → 主线程处理器。inline 路径只支持同步纯处理器（无第二线程可停靠），
     * 有 FS 效果或异步的处理器只在 worker 路径可用；与 applet/内建同名会在创建时抛错。
     */
    hostCommands?: HostCommandRegistry;
}
export declare function createBusyboxShell(store: ShellFsStore, options?: BusyboxShellOptions): Shell;
/**
 * 对账的纯函数部分（从 `pulledChanges` 拆出仅为可测：真 worker 在 node 下起不来）。
 * 删除集 = 推出去的 − 现在还在的；目录也要对账（guest `rm -rf`/`mv` 目录后宿主不留空壳），
 * 按深度降序删，保证到父目录时已空。
 */
export declare function reconcilePulled(pushed: WasiFsChanges, pulled: WasiFsChanges): WasiFsChanges;
