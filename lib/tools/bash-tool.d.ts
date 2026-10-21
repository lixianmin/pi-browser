import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool.js';
import { type OutputAccumulatorSpill } from '../shell/output-accumulator.js';
import { type TruncationResult } from './truncate.js';
declare const bashSchema: Type.TObject<{
    command: Type.TString;
    timeout: Type.TOptional<Type.TNumber>;
}>;
export declare const bashToolSystemPromptContribution: {
    readonly snippet: 'Execute bash commands (ls, grep, find, etc.)';
    readonly guidelines: readonly ['You can inspect PI_* environment variables for current model and session details.'];
};
export type BashToolInput = Static<typeof bashSchema>;
/** 上游 1.0.2 `BashToolDetails`：exit code 只进 content 文本，不在 details 里 */
export interface BashToolDetails {
    truncation?: TruncationResult;
    fullOutputPath?: string;
}
/** 可插拔的命令执行操作（对齐上游 `BashOperations`；`Buffer` → `Uint8Array`，D1）。 */
export interface BashOperations {
    /**
     * 执行命令并流式交付输出。返回退出码；`null` 视为失败（工具会抛错）。
     */
    exec(command: string, cwd: string, options: {
        onData(data: Uint8Array): void;
        signal?: AbortSignal;
        timeout?: number;
        env?: Record<string, string>;
    }): Promise<{
        exitCode: number | null;
    }>;
}
export interface BashToolOptions {
    /** 命令执行操作。浏览器没有默认 shell，缺省即抛（D5） */
    operations?: BashOperations;
    /** 本仓扩展：`OutputAccumulator` 的临时文件 seam；缺省则不落盘、`fullOutputPath` 留空 */
    spill?: OutputAccumulatorSpill;
    /** 每条命令前拼一段前缀（例如 shell 初始化），对齐上游 `commandPrefix` */
    commandPrefix?: string;
}
export declare function createBashToolDefinition(cwd: string, options?: BashToolOptions): ToolDefinition<typeof bashSchema, BashToolDetails | undefined>;
export declare function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema>;
export {};
