// src/tools/ls-tool.ts —— Ls 工具（P2c Task 16）。
// 契约面 1:1 于 pi-coding-agent@1.0.0 dist/core/tools/ls.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / LsOperations / LsToolDetails / 两导出形状；输出与 notices 文案逐字上游。
// 实现体自持：fs 访问由调用方注入 `LsOperations`（D5，上游走 node:fs）。
// 行为变化（对齐上游）：`recursive` 字段删除（上游没有），输出是**条目名**（不是相对 cwd 的路径）。

import { type Static, Type } from 'typebox';
import { FileError } from '@earendil-works/pi-durable/env';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool';
import { normalizePath } from '../env/path';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from './truncate';
import { resolveToCwd } from './path-utils';
import { throwIfAborted } from './fs-ops';

const DEFAULT_LIMIT = 500;

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: 'Directory to list (default: current directory)' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of entries to return (default: 500)' })),
});

export const lsToolSystemPromptContribution = {
	snippet: 'List directory contents',
	guidelines: [],
} as const;

const lsToolDescription = `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`;

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
	stat(absolutePath: string): Promise<{ isDirectory(): boolean }> | { isDirectory(): boolean };
	/** 读目录条目（名字） */
	readdir(absolutePath: string): Promise<string[]> | string[];
}

export interface LsToolOptions {
	/** 列目录操作。浏览器没有默认文件系统，缺省即抛（D5） */
	operations?: LsOperations;
}

function requireOperations(options: LsToolOptions | undefined): LsOperations {
	const operations = options?.operations;
	if (operations === undefined) {
		throw new Error('ls tool: 浏览器没有默认文件系统，请在 options.operations 注入 LsOperations（D5）');
	}
	return operations;
}

async function executeLs(
	cwd: string,
	input: LsToolInput,
	signal: AbortSignal | undefined,
	operations: LsOperations,
): Promise<AgentToolResult<LsToolDetails | undefined>> {
	throwIfAborted(signal);
	const dirPath = resolveToCwd(input.path ?? '.', cwd);
	const effectiveLimit = input.limit ?? DEFAULT_LIMIT;
	if (!(await operations.exists(dirPath))) {
		throw new FileError('not_found', `Path not found: ${dirPath}`, dirPath);
	}
	throwIfAborted(signal);
	const stat = await operations.stat(dirPath);
	if (!stat.isDirectory()) {
		throw new FileError('not_directory', `Not a directory: ${dirPath}`, dirPath);
	}
	let entries: string[];
	try {
		entries = await operations.readdir(dirPath);
	} catch (e) {
		throw new FileError('unknown', `Cannot read directory: ${(e as Error).message}`, dirPath);
	}
	throwIfAborted(signal);
	// 不区分大小写排序（上游同款）
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const results: string[] = [];
	let entryLimitReached = false;
	for (const entry of entries) {
		if (results.length >= effectiveLimit) {
			entryLimitReached = true;
			break;
		}
		const fullPath = normalizePath(dirPath === '/' ? `/${entry}` : `${dirPath}/${entry}`);
		let suffix = '';
		try {
			if ((await operations.stat(fullPath)).isDirectory()) suffix = '/';
		} catch {
			continue;   // 取不到状态的条目跳过（上游同款）
		}
		results.push(entry + suffix);
	}
	throwIfAborted(signal);
	if (results.length === 0) {
		return { content: [{ type: 'text', text: '(empty directory)' }], details: undefined };
	}
	const truncation = truncateHead(results.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: LsToolDetails = {};
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		details.entryLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
	return { content: [{ type: 'text', text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const operations = requireOperations(options);
	return {
		name: 'ls',
		label: 'ls',
		description: lsToolDescription,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		execute: (toolCallId, input, signal, _onUpdate, ctx) => executeLs(ctx?.cwd || cwd, input, signal, operations),
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	const operations = requireOperations(options);
	return {
		name: 'ls',
		label: 'ls',
		description: lsToolDescription,
		parameters: lsSchema,
		execute: (toolCallId, input, signal, _onUpdate) => executeLs(cwd, input, signal, operations),
	};
}
