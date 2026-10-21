import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool.js';
import { type TruncationResult } from './truncate.js';
import { type ImagePhoton, type ImageResizeOptions } from './image-process.js';
declare const readSchema: Type.TObject<{
    path: Type.TString;
    offset: Type.TOptional<Type.TNumber>;
    limit: Type.TOptional<Type.TNumber>;
}>;
export declare const readToolSystemPromptContribution: {
    readonly snippet: 'Read file contents';
    readonly guidelines: readonly ['Use read to examine files instead of cat or sed.'];
};
export type ReadToolInput = Static<typeof readSchema>;
export interface ReadToolDetails {
    truncation?: TruncationResult;
}
/** 可插拔的文件读取操作（对齐上游 `ReadOperations`；`Buffer` → `Uint8Array`，D1）。 */
export interface ReadOperations {
    readFile(absolutePath: string): Promise<Uint8Array>;
    /** 检查文件可读（失败即 throw） */
    access(absolutePath: string): Promise<void>;
    /** 嗅探图片 MIME；非图片返回 null/undefined。缺省则不识别图片 */
    detectImageMimeType?(absolutePath: string): Promise<string | null | undefined>;
}
export interface ReadToolOptions {
    /** 是否自动缩放图片。默认 true（上游语义）。 */
    autoResizeImages?: boolean;
    /**
     * 模型元数据缺失时的兜底缩放档。**透传给注入的 `photon.resizeImage`（上游同样原样透传，不替宿主补缺省）**；
     * 不注入 `photon` 时只有 `maxBytes` 在本包生效（缺省 4.5MB base64，上游常量），2000×2000 / jpegQuality 80
     * 需要宿主自己的 `photon` 实现兜。
     */
    resizeOptions?: ImageResizeOptions;
    /**
     * 像素活实现（上游 `@silvia-odwyer/photon-node` 的浏览器版缝：上游 `loadPhoton()` 加载的是 CJS +
     * `fs.readFileSync(wasm)`，浏览器里不可用）。函数名与签名逐字取自上游的
     * `resizeImage` / `convertImageBytesToPng`，宿主绑进来即可；不注入则只查 base64 字节上限。
     */
    photon?: ImagePhoton;
    /** 文件读取操作。浏览器没有默认文件系统，缺省即抛（D5） */
    operations?: ReadOperations;
}
export declare function createReadToolDefinition(cwd: string, options?: ReadToolOptions): ToolDefinition<typeof readSchema, ReadToolDetails | undefined>;
export declare function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema>;
export {};
