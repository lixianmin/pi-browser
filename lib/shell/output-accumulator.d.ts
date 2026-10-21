import { type TruncationResult } from '../tools/truncate.js';
import type { FileSystem } from '../env/types.js';
export interface OutputAccumulatorOptions {
    /** 展示窗口的行数上限（默认 `DEFAULT_MAX_LINES`） */
    maxLines?: number;
    /** 展示窗口的字节上限（默认 `DEFAULT_MAX_BYTES`） */
    maxBytes?: number;
    /** spill 文件名前缀（默认 `'pi-output'`） */
    tempFilePrefix?: string;
}
export interface OutputSnapshot {
    content: string;
    truncation: TruncationResult;
    /** spill 已发生时的**浏览器虚拟路径**（如 `/tmp/pi-output-ab12.log`），不是宿主真实路径（D2） */
    fullOutputPath?: string;
}
export interface FullOutput {
    content: string;
    /** `content` 是否省略了一部分输出 */
    truncated: boolean;
}
/** spill 文件句柄：`append` 同步入队（内部串行），`close` 时 await 全部落地。
 *  写入失败只会在 `close()` 处抛——**调用方必须 close**，否则一次落盘失败会被永久吞掉（见 `closeTempFile`）。 */
export interface OutputAccumulatorSpillFile {
    readonly path: string;
    append(data: Uint8Array): void;
    close(): Promise<void>;
}
export interface OutputAccumulatorSpill {
    create(prefix: string): OutputAccumulatorSpillFile;
    read(path: string): Promise<Uint8Array>;
}
/**
 * 有界内存地增量跟踪流式输出。
 *
 * `append` 用流式 UTF-8 解码器吃分片，只保留一段解码尾巴供展示快照；一旦跨过阈值就通过注入的
 * spill seam 把完整输出落盘，后续分片直接写盘、不再留在内存里（同上游的有界内存做法）。
 */
export declare class OutputAccumulator {
    #private;
    constructor(options?: OutputAccumulatorOptions, spill?: OutputAccumulatorSpill);
    /** 喂一段原始输出（stdout/stderr **合并**；上游 Node 实现同样把两路喂进一个视图） */
    append(data: Uint8Array): void;
    /** 收尾：刷掉解码器里未成形的尾部字节；超阈值时建 spill 文件 */
    finish(): void;
    snapshot(options?: {
        persistIfTruncated?: boolean;
    }): OutputSnapshot;
    /**
     * 关掉 spill 文件（写队列落地）。路径保留，之后再 `readFullOutput` 仍可读。
     * **必调**：spill 的写入失败只在 `close()` 处抛（`append` 把第一个失败记下来），不调就等于把落盘失败吞掉，
     * 而且此时 `readFullOutput` 会读到写了一半的文件。
     */
    closeTempFile(): Promise<void>;
    /**
     * 完整输出给能吃下不止展示快照的调用方。应在 `finish()` 与 `closeTempFile()` 之后调。
     * 长于 `maxBytes` 原始字节时保留首尾各 `maxBytes / 2` 字节，中间换成省略标记（上游同形）。
     */
    readFullOutput(maxBytes: number): Promise<FullOutput>;
    getLastLineBytes(): number;
}
/**
 * 用挂载表实现 spill seam（D2）：落在挂载表的临时文件面（默认 `/tmp`，即内存挂载）。
 * 返回的路径是**虚拟路径**——只有同一个 env 读得到（spec Review Focus #1 有测试钉住）。
 *
 * 两个已知后果（有意，非待办）：① 不走表的 `createTempFile` 原语而是自己拼 `/tmp/...`，因为句柄要同步给出
 * `path` 而那个原语是异步的；② 文件永不删除（上游 tempfile 也不删）。没有 `/tmp` 挂载时，路径会落到兜底
 * 的 `/` 挂载上——默认浏览器装配里那是**持久的 IDB 会话库**，所以宿主不该只挂 `/` 却又要 spill。
 */
export declare function createMountSpill(table: FileSystem, prefix?: string): OutputAccumulatorSpill;
