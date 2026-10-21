import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool.js';
declare const editSchema: Type.TObject<{
    path: Type.TString;
    edits: Type.TArray<Type.TObject<{
        oldText: Type.TString;
        newText: Type.TString;
    }>>;
}>;
export declare const editToolSystemPromptContribution: {
    readonly snippet: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call';
    readonly guidelines: readonly ['Use edit for precise changes (edits[].oldText must match exactly)', 'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls', 'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.', 'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.'];
};
export type EditToolInput = Static<typeof editSchema>;
export interface EditToolDetails {
    /** 面向展示、带行号的 diff */
    diff: string;
    /** 标准 unified patch */
    patch: string;
    /** 新文件里首个变更的行号（编辑器跳转用） */
    firstChangedLine?: number;
}
/** 可插拔的文件编辑操作（对齐上游 `EditOperations`；`Buffer` → `Uint8Array`，D1）。 */
export interface EditOperations {
    readFile(absolutePath: string): Promise<Uint8Array>;
    writeFile(absolutePath: string, content: string): Promise<void>;
    /** 检查文件可读可写（失败即 throw） */
    access(absolutePath: string): Promise<void>;
}
export interface EditToolOptions {
    /** 文件编辑操作。浏览器没有默认文件系统，缺省即抛（D5） */
    operations?: EditOperations;
}
export declare function createEditToolDefinition(cwd: string, options?: EditToolOptions): ToolDefinition<typeof editSchema, EditToolDetails | undefined>;
/** AgentTool 工厂：`AgentTool.execute` 只有 4 参（F6），cwd 恒为构造期值；需要 `ctx.cwd` 覆盖请用定义件。 */
export declare function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema>;
export {};
