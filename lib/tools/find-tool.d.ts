import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool.js';
import { type TruncationResult } from './truncate.js';
declare const findSchema: Type.TObject<{
    pattern: Type.TString;
    path: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TNumber>;
}>;
export declare const findToolSystemPromptContribution: {
    readonly snippet: 'Find files by glob pattern (respects .gitignore)';
    readonly guidelines: readonly [];
};
export type FindToolInput = Static<typeof findSchema>;
export interface FindToolDetails {
    truncation?: TruncationResult;
    resultLimitReached?: number;
}
/** 可插拔的文件查找操作（对齐上游 `FindOperations`）。 */
export interface FindOperations {
    /** 路径是否存在 */
    exists(absolutePath: string): Promise<boolean> | boolean;
    /**
     * 按 glob 找文件；返回相对或绝对路径。
     * 浏览器端 glob 引擎需接受 picomatch 语法：工具会先用 picomatch 校验 pattern（非法即 `FileError('invalid')`）。
     */
    glob(pattern: string, cwd: string, options: {
        ignore: string[];
        limit: number;
    }): Promise<string[]> | string[];
}
export interface FindToolOptions {
    /** 文件查找操作。浏览器没有默认文件系统，缺省即抛（D5） */
    operations?: FindOperations;
}
/** 上游同名（`find.js:10`）：把结果相对搜索根、归一为 posix 分隔符。浏览器版去掉 node `pathModule` 参数。 */
export declare function relativizeFindResultPath(resultPath: string, searchPath: string): string;
export declare function createFindToolDefinition(cwd: string, options?: FindToolOptions): ToolDefinition<typeof findSchema, FindToolDetails | undefined>;
export declare function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema>;
export {};
