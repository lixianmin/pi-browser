/** 调用方注入的「可读性」谓词：成功 resolve、失败 reject（与上游 `ReadOperations.access` 同契约）。 */
export type AccessPath = (absolutePath: string) => Promise<void>;
/** 上游同名：存在性检查。上游吃 node:fs 的 access，浏览器版吃注入谓词（见文件头 ①）。 */
export declare function pathExists(filePath: string, access: AccessPath): Promise<boolean>;
export declare function expandPath(filePath: string): string;
/** 相对路径解析为绝对归一化路径（基于 cwd）。 */
export declare function resolveToCwd(filePath: string, cwd: string): string;
/**
 * 上游同步版用 `accessSync` 探测 macOS 变体；浏览器没有同步 fs（没有同步谓词可用），
 * 这里退化为纯解析。需要变体探测的调用方走 `resolveReadPathAsync`。
 */
export declare function resolveReadPath(filePath: string, cwd: string): string;
export declare function resolveReadPathAsync(filePath: string, cwd: string, access: AccessPath): Promise<string>;
