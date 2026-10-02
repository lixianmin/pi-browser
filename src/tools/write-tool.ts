// src/tools/write-tool.ts —— Write 工具（P2b Task 12）。
// 契约面 1:1 于 pi-coding-agent@1.0.0 dist/core/tools/write.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / promptGuidelines / WriteOperations / 两导出形状（details 恒为 undefined）。
// 实现体自持：fs 由调用方注入（D5）；不移植上游的 `withFileMutationQueue`（实现体、非契约面）。
// 成功文案与上游逐字：`Successfully wrote to <path>`（本仓旧版的 `(N bytes)` 后缀已删）。

import { type Static, Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool';
import { dirname } from '../env/path';
import { resolveToCwd } from './path-utils';
import { throwIfAborted } from './fs-ops';

const writeSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
	content: Type.String({ description: 'Content to write to the file' }),
});

export const writeToolSystemPromptContribution = {
	snippet: 'Create or overwrite files',
	guidelines: ['Use write only for new files or complete rewrites.'],
} as const;

const writeToolDescription = "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";

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

/** 浏览器没有默认文件系统（D5）：缺省即响亮报错。 */
function requireOperations(options: WriteToolOptions | undefined): WriteOperations {
	const operations = options?.operations;
	if (operations === undefined) {
		throw new Error('write tool: 浏览器没有默认文件系统，请在 options.operations 注入 WriteOperations（D5）');
	}
	return operations;
}

async function executeWrite(
	cwd: string,
	input: WriteToolInput,
	signal: AbortSignal | undefined,
	operations: WriteOperations,
): Promise<AgentToolResult<undefined>> {
	throwIfAborted(signal);
	const absolutePath = resolveToCwd(input.path, cwd);
	const dir = dirname(absolutePath);
	await operations.mkdir(dir);
	throwIfAborted(signal);
	await operations.writeFile(absolutePath, input.content);
	throwIfAborted(signal);
	return { content: [{ type: 'text', text: `Successfully wrote to ${input.path}` }], details: undefined };
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const operations = requireOperations(options);
	return {
		name: 'write',
		label: 'write',
		description: writeToolDescription,
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		execute: (toolCallId, input, signal, _onUpdate, ctx) => executeWrite(ctx?.cwd ?? cwd, input, signal, operations),
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	const operations = requireOperations(options);
	return {
		name: 'write',
		label: 'write',
		description: writeToolDescription,
		parameters: writeSchema,
		execute: (toolCallId, input, signal, _onUpdate) => executeWrite(cwd, input, signal, operations),
	};
}
