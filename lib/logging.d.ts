/**
 * 把任意入参压成一行可进日志的字符串：字符串原样（不加引号——命令、路径这类直接可读），
 * 其余 JSON 化（`safeStringify` 保证循环引用/BigInt 不炸），超长截断。截断标记用 `…`（末尾可见）。
 */
export declare function summarize(value: unknown, maxChars?: number): string;
