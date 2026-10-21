import type { HostBuiltins } from 'wasi-sh';
import type { BrowserFileSystem, MountEntry } from '../env/types.js';
import { type ShellFsStore, type WasiFileSystem, type WasiFsChanges } from './wasi-fs.js';
export interface HostCommandRequest {
    /** 命令名（注册时的 key；argv[0]） */
    name: string;
    /** argv[1..]（不含命令名） */
    args: string[];
    /** guest 侧的当前工作目录 */
    cwd: string;
    /** guest 从 fd 0 读到的内容；无输入时为 undefined（详见 README「宿主命令」） */
    stdin?: string;
    /** guest 的实时环境（exports + 本命令的 VAR=x 前缀） */
    env?: Record<string, string>;
    /**
     * 宿主侧挂载表（只由 worker 路径的 createHostCommandResponder 填入；inline 路径拿不到）。
     * 给 `mount` 这类需要知道「工作区由哪些挂载点组成」的命令用。
     */
    mounts?: MountEntry[];
}
export interface HostCommandResult {
    exitCode: number;
    stdout?: string;
    stderr?: string;
}
/** 处理器在**主线程**执行，允许 async（inline 路径例外：见 createInlineHostBuiltins） */
export type HostCommandHandler = (request: HostCommandRequest, fs: BrowserFileSystem) => Promise<HostCommandResult> | HostCommandResult;
/** 名字 → 处理器（注册表；`createBrowserExecutionEnv({ hostCommands })`） */
export type HostCommandRegistry = Record<string, HostCommandHandler>;
/**
 * shell 能自行解析的名字：busybox applet + ash 内建。两个用途：
 *   1. `hostCommandNames` 拒绝同名注册——ash 的解析顺序是 函数 → shell 内建 → applet → 宿主内建 → PATH，
 *      同名宿主命令**永远不会被调用**（被 applet 静默抢走）；
 *   2. `which` 判定「这个名字能不能用」——wasi-sh 里 applet 不是 PATH 上的文件，
 *      纯文件查找找不到它们（实测 `which ls` -> exit 1，而 `ls` 能跑）。
 *
 * 来源：`scripts/busybox.config` 编出的 wasm 里实际启用的 applet
 *（`//applet:IF_*` × `.config` 里 `CONFIG_*=y`）+ ash 内建名。
 * 改 `scripts/busybox.config` 或升级 busybox 后必须重新对账：漏掉的名字会被静默抢走，
 * 多出来的名字只是误拒（保守方向）。当前对应 wasm：src/shell/busybox.wasm。
 */
export declare const RESERVED_COMMAND_NAMES: ReadonlySet<string>;
/**
 * 校验注册表并返回名字清单（供 worker 消息与 builtins 的 `lookup`）。
 * 与 applet/内建同名 → 抛错（不静默覆盖内建，也不静默失效）。
 */
export declare function hostCommandNames(registry: HostCommandRegistry): string[];
/** guest 侧等待宿主应答的上限；exec 路径传 exec 自己的 timeout（未设时用这个值） */
export declare const DEFAULT_HOST_COMMAND_TIMEOUT_MS = 30000;
export interface HostCommandExchangeRequest extends HostCommandRequest {
    /** guest 侧自上次对账以来的变更集（drain 出来的） */
    changes: WasiFsChanges;
}
export interface HostCommandExchangeResult extends HostCommandResult {
    /** 宿主侧写回 guest 的净变化（处理器引起的） */
    changes: WasiFsChanges;
}
export interface HostCommandGuestSide {
    /** 写入请求并通知宿主；返回本次请求的序号（非阻塞） */
    send(request: HostCommandExchangeRequest): number;
    /** 阻塞等待该序号被应答（worker 内同步 builtin 唯一的等待方式）；超时抛错 */
    wait(seq: number): void;
    /** 读取应答；该序号还没被应答时抛错 */
    read(seq: number): HostCommandExchangeResult;
    /** send + wait + read（worker 内 builtin 用的整条同步路径） */
    call(request: HostCommandExchangeRequest): HostCommandExchangeResult;
}
export type HostCommandResponder = (request: HostCommandRequest, changes: WasiFsChanges) => Promise<HostCommandExchangeResult>;
export interface HostCommandHostSide {
    /** 等待并应答一次请求；返回 false 表示已 stop（单次交换，与 serve 共用同一份应答逻辑） */
    respondOnce(responder: HostCommandResponder): Promise<boolean>;
    /** 一直应答到 stop() */
    serve(responder: HostCommandResponder): Promise<void>;
    /** 停止应答循环（同时递增请求序号唤醒等待中的宿主侧，不阻塞调用方） */
    stop(): void;
}
export interface HostCommandChannel {
    hostSide: HostCommandHostSide;
    guestSide: HostCommandGuestSide;
}
/** 主线程 → worker 的通道投递消息（必须早于 spawn 的启动消息：同一 worker 的 postMessage 是 FIFO） */
export declare const HOST_COMMAND_SAB_MESSAGE = "pi-browser:host-commands";
export interface HostCommandSabMessage {
    type: typeof HOST_COMMAND_SAB_MESSAGE;
    sab: SharedArrayBuffer;
    names: string[];
    timeoutMs: number;
}
/** 按容量分配 SAB（容量由 SAB 长度推出，两侧不会各说各的） */
export declare function createHostCommandSharedBuffer(options?: {
    capacity?: number;
}): SharedArrayBuffer;
export declare function createHostCommandChannel(sab: SharedArrayBuffer, options?: {
    timeoutMs?: number;
}): HostCommandChannel;
/**
 * 主机侧（worker 路径的主线程）单条请求的应答：① guest 变更落权威 store ② 处理器读写权威 store
 * ③ 把 store 的净变化算出来回传。处理器抛错 → exitCode=1 + stderr 摘要（不让 worker 挂死）。
 */
export declare function createHostCommandResponder(store: ShellFsStore, handlers: HostCommandRegistry): HostCommandResponder;
/**
 * worker 侧的宿主命令 builtins（同步）：每次调用把 guest 变更集 drain 出去发给主线程，
 * 停靠等应答，再把宿主侧的净变化落回缓存（所以 guest 立刻能读到处理器的写）。
 */
export declare function createGuestHostBuiltins(guestFs: WasiFileSystem, channel: HostCommandGuestSide, names: readonly string[]): HostBuiltins;
/**
 * inline 路径的宿主命令 builtins：直接同步调处理器（无停靠）。只支持**同步纯处理器**——
 * 异步处理器（返回 thenable）在这里明确抛错，因为 guest 帧里没人能 await 它。
 */
export declare function createInlineHostBuiltins(handlers: HostCommandRegistry): HostBuiltins;
