import { type Logger } from '@needle/logo';
export type { Logger };
/** 本仓日志器：宿主从公开面拿到它，`addSink` 挂自己的 sink 即接管本仓全部日志。 */
export declare const logger: Logger;
/**
 * 把任意入参压成一行可进日志的字符串：字符串原样（不加引号——命令、路径这类直接可读），
 * 其余 JSON 化（`safeStringify` 保证循环引用/BigInt 不炸），超长截断。截断标记用 `…`（末尾可见）。
 */
export declare function summarize(value: unknown, maxChars?: number): string;
