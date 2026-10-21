export declare const DEFAULT_MAX_LINES = 2000;
export declare const DEFAULT_MAX_BYTES: number;
export declare const GREP_MAX_LINE_LENGTH = 500;
export interface TruncationResult {
    content: string;
    truncated: boolean;
    truncatedBy: 'lines' | 'bytes' | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
    lastLinePartial: boolean;
    firstLineExceedsLimit: boolean;
    maxLines: number;
    maxBytes: number;
}
export interface TruncationOptions {
    maxLines?: number;
    maxBytes?: number;
}
/** 字符串 UTF-8 字节长度（跨端：浏览器无 Buffer）。名字对齐上游 `utf8ByteLength`（pi-durable@1.0.2 `dist/truncate.d.ts`、pi-agent-core@0.99.1 `harness/utils/truncate.js:15`）。 */
export declare function utf8ByteLength(content: string): number;
export declare function formatSize(bytes: number): string;
/** 从头部截断（保留前 N 行/N 字节）。适合文件 Read 场景。 */
export declare function truncateHead(content: string, options?: TruncationOptions): TruncationResult;
/**
 * 从尾部截断（保留后 N 行/N 字节）。适合 shell 输出——想看的是结尾（报错、最终结果）。
 * 与上游 `pi-agent-core@0.99.1 harness/utils/truncate.js:178` 逐字对齐（含「单行超字节上限时
 * 从尾部取部分行」的分支）。这是唯一会产出 `lastLinePartial = true` 的路径。
 */
export declare function truncateTail(content: string, options?: TruncationOptions): TruncationResult;
/** 单行截断（grep 输出专用），超长行尾加 "... [truncated]"。 */
export declare function truncateLine(line: string, maxChars?: number): {
    text: string;
    wasTruncated: boolean;
};
export interface MiddleTruncationResult {
    /** 头 + `…N chars truncated…` + 尾 */
    content: string;
    truncated: boolean;
    /** 被省略的字符数（按 Unicode 码点计，不是字节数） */
    removedChars: number;
    totalBytes: number;
    totalLines: number;
}
/**
 * 保留 `content` 的头与尾（各占 `maxBytes` 的一半），中间换成 `…N chars truncated…` 标记。
 * 只在字符边界切。转写源：pi-coding-agent@1.0.2 dist/core/tools/truncate.js:219-243
 * （唯一偏离：`Buffer` → `TextEncoder` / `TextDecoder`，见 spec D1）。
 */
export declare function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult;
