import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types.js';
import type { ToolDefinition } from '../extensions/tool.js';
import { type TruncationResult } from './truncate.js';
declare const grepSchema: Type.TObject<{
    pattern: Type.TString;
    path: Type.TOptional<Type.TString>;
    glob: Type.TOptional<Type.TString>;
    ignoreCase: Type.TOptional<Type.TBoolean>;
    literal: Type.TOptional<Type.TBoolean>;
    context: Type.TOptional<Type.TNumber>;
    limit: Type.TOptional<Type.TNumber>;
}>;
export declare const grepToolSystemPromptContribution: {
    readonly snippet: 'Search file contents for patterns (respects .gitignore)';
    readonly guidelines: readonly [];
};
export type GrepToolInput = Static<typeof grepSchema>;
export interface GrepToolDetails {
    truncation?: TruncationResult;
    matchLimitReached?: number;
    linesTruncated?: boolean;
}
/** 可插拔的搜索操作（对齐上游 `GrepOperations`）。 */
export interface GrepOperations {
    /** 路径是否是目录；路径不存在时 throw */
    isDirectory(absolutePath: string): Promise<boolean> | boolean;
    /** 读文件内容（上下文行用） */
    readFile(absolutePath: string): Promise<string> | string;
}
export interface GrepToolOptions {
    /** 覆盖上游两条缝；缺省由本仓基于 `fs` 实现 */
    operations?: GrepOperations;
    /** 遍历源（本仓扩展：上游 grep 把遍历外包给 rg，浏览器没有） */
    fs: BrowserFileSystem;
}
export declare function createGrepToolDefinition(cwd: string, options?: GrepToolOptions): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined>;
export declare function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema>;
export {};
