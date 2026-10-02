// src/tools/find-tool.ts —— Find 工具（P2c Task 15）。
// 契约面 1:1 于 pi-coding-agent@1.0.0 dist/core/tools/find.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / FindOperations / FindToolDetails / 导出 `relativizeFindResultPath` / 两导出形状。
// 实现体自持：上游把文件查找外包给 fd，本仓由调用方注入 `FindOperations.glob`（D5），工具只做
// 结果相对化、limit 与截断。平台偏差：文案声明 `respects .gitignore`，本仓不读 .gitignore（P6 README）。

import picomatch from './picomatch-typed';
import { type Static, Type } from 'typebox';
import { FileError } from '@earendil-works/pi-durable/env';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool';
import { normalizePath } from '../env/path';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from './truncate';
import { resolveToCwd } from './path-utils';
import { throwIfAborted } from './fs-ops';

const DEFAULT_LIMIT = 1000;

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: 'Directory to search in (default: current directory)' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of results (default: 1000)' })),
});

export const findToolSystemPromptContribution = {
	snippet: 'Find files by glob pattern (respects .gitignore)',
	guidelines: [],
} as const;

const findToolDescription = `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`;

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
	glob(pattern: string, cwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> | string[];
}

export interface FindToolOptions {
	/** 文件查找操作。浏览器没有默认文件系统，缺省即抛（D5） */
	operations?: FindOperations;
}

function requireOperations(options: FindToolOptions | undefined): FindOperations {
	const operations = options?.operations;
	if (operations === undefined) {
		throw new Error('find tool: 浏览器没有默认文件系统，请在 options.operations 注入 FindOperations（D5）');
	}
	return operations;
}

/** 上游同名（`find.js:10`）：把结果相对搜索根、归一为 posix 分隔符。浏览器版去掉 node `pathModule` 参数。 */
export function relativizeFindResultPath(resultPath: string, searchPath: string): string {
	const hadTrailingSeparator = resultPath.endsWith('/');
	const relativePath = resultPath.startsWith('/') ? relativeTo(resultPath, searchPath) : resultPath;
	const posixPath = relativePath;
	return hadTrailingSeparator && !posixPath.endsWith('/') ? `${posixPath}/` : posixPath;
}

/** 搜索根到目标的相对路径（与 node `path.relative` 同语义：根外的目标得到 `../…`）。 */
function relativeTo(target: string, base: string): string {
	const from = normalizePath(base).split('/').filter((segment) => segment !== '');
	const to = normalizePath(target).split('/').filter((segment) => segment !== '');
	let common = 0;
	while (common < from.length && common < to.length && from[common] === to[common]) common++;
	const up = Array.from({ length: from.length - common }, () => '..');
	return [...up, ...to.slice(common)].join('/');
}

async function executeFind(
	cwd: string,
	input: FindToolInput,
	signal: AbortSignal | undefined,
	operations: FindOperations,
): Promise<AgentToolResult<FindToolDetails | undefined>> {
	throwIfAborted(signal);
	const searchPath = resolveToCwd(input.path ?? '.', cwd);
	const effectiveLimit = input.limit ?? DEFAULT_LIMIT;
	if (!(await operations.exists(searchPath))) {
		throw new FileError('not_found', `Path not found: ${searchPath}`, searchPath);
	}
	throwIfAborted(signal);
	compileGlob(input.pattern);   // 浏览器 glob 引擎（picomatch）的语法校验 → FileError invalid
	const results = await operations.glob(input.pattern, searchPath, { ignore: ['**/node_modules/**', '**/.git/**'], limit: effectiveLimit });
	throwIfAborted(signal);
	if (results.length === 0) {
		return { content: [{ type: 'text', text: 'No files found matching pattern' }], details: undefined };
	}
	// 与上游一致：结果相对搜索根（不是 cwd）
	const relativized = results.map((resultPath) => relativizeFindResultPath(resultPath, searchPath));
	const resultLimitReached = relativized.length >= effectiveLimit;
	const truncation = truncateHead(relativized.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached`);
		details.resultLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
	return { content: [{ type: 'text', text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const operations = requireOperations(options);
	return {
		name: 'find',
		label: 'find',
		description: findToolDescription,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		execute: (toolCallId, input, signal, _onUpdate, ctx) => executeFind(ctx?.cwd || cwd, input, signal, operations),
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	const operations = requireOperations(options);
	return {
		name: 'find',
		label: 'find',
		description: findToolDescription,
		parameters: findSchema,
		execute: (toolCallId, input, signal, _onUpdate) => executeFind(cwd, input, signal, operations),
	};
}

function compileGlob(pattern: string): (input: string) => boolean {
	try {
		return picomatch(pattern);
	} catch (e) {
		throw new FileError('invalid', `Invalid glob pattern: ${(e as Error).message}`);
	}
}
