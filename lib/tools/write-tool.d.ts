import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool.js';
declare const writeSchema: Type.TObject<{
    path: Type.TString;
    content: Type.TString;
}>;
export declare const writeToolSystemPromptContribution: {
    readonly snippet: 'Create or overwrite files';
    readonly guidelines: readonly ['Use write only for new files or complete rewrites.'];
};
export type WriteToolInput = Static<typeof writeSchema>;
/** 可插拔的文件写入操作（对齐上游 `WriteOperations`）。 */
export interface WriteOperations {
    writeFile(absolutePath: string, content: string): Promise<void>;
    /** 递归创建目录 */
    mkdir(dir: string): Promise<void>;
}
export interface WriteToolOptions {
    /** 文件写入操作。浏览器没有默认文件系统，缺省即抛（D5） */
    operations?: WriteOperations;
}
export declare function createWriteToolDefinition(cwd: string, options?: WriteToolOptions): ToolDefinition<typeof writeSchema, undefined>;
/** AgentTool 工厂：`AgentTool.execute` 只有 4 参（F6），cwd 恒为构造期值；需要 `ctx.cwd` 覆盖请用定义件。 */
export declare function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema>;
export {};
