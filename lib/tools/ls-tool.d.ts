import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool.js';
import { type TruncationResult } from './truncate.js';
declare const lsSchema: Type.TObject<{
    path: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TNumber>;
}>;
export declare const lsToolSystemPromptContribution: {
    readonly snippet: 'List directory contents';
    readonly guidelines: readonly [];
};
export type LsToolInput = Static<typeof lsSchema>;
export interface LsToolDetails {
    truncation?: TruncationResult;
    entryLimitReached?: number;
}
/** 可插拔的列目录操作（对齐上游 `LsOperations`）。 */
export interface LsOperations {
    /** 路径是否存在 */
    exists(absolutePath: string): Promise<boolean> | boolean;
    /** 取文件/目录状态；不存在时 throw */
    stat(absolutePath: string): Promise<{
        isDirectory(): boolean;
    }> | {
        isDirectory(): boolean;
    };
    /** 读目录条目（名字） */
    readdir(absolutePath: string): Promise<string[]> | string[];
}
export interface LsToolOptions {
    /** 列目录操作。浏览器没有默认文件系统，缺省即抛（D5） */
    operations?: LsOperations;
}
export declare function createLsToolDefinition(cwd: string, options?: LsToolOptions): ToolDefinition<typeof lsSchema, LsToolDetails | undefined>;
export declare function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema>;
export {};
