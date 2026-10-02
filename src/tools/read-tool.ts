// src/tools/read-tool.ts —— Read 工具（P2b Task 11）。
// 契约面 1:1 于 pi-coding-agent@1.0.0 dist/core/tools/read.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / promptGuidelines / ReadToolDetails / ReadOperations / 两导出形状。
// 实现体自持（spec §3.1）：片段构造与截断文案按上游逐字转写，fs 访问由调用方注入（D5），
// 输入/fs 错误仍是带 FileErrorCode 的 FileError（spec §3.3）。
// D6 / R1：图片只做 magic-byte 嗅探、不做缩放；autoResizeImages / resizeOptions 字段保留但不消费。

import { type Static, Type } from 'typebox';
import { FileError } from '@earendil-works/pi-durable/env';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, utf8ByteLength, type TruncationResult } from './truncate';
import { resolveReadPathAsync } from './path-utils';
import { throwIfAborted } from './fs-ops';

const readSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
	offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});

export const readToolSystemPromptContribution = {
	snippet: 'Read file contents',
	guidelines: ['Use read to examine files instead of cat or sed.'],
} as const;

const readToolDescription = `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;

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
	/** 是否自动缩放图片。默认 true。浏览器侧只保留形状，不消费（D6/R1） */
	autoResizeImages?: boolean;
	/** 模型元数据缺失时的兜底缩放档。浏览器侧不消费（D6/R1） */
	resizeOptions?: unknown;
	/** 文件读取操作。浏览器没有默认文件系统，缺省即抛（D5） */
	operations?: ReadOperations;
}

/** 与上游 `Buffer.toString('utf-8')` 等价：`ignoreBOM: true` 表示不吞掉开头的 BOM（默认会吞）。 */
const _decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** 浏览器没有默认文件系统（D5）：缺省即响亮报错，不静默用一个坏默认。 */
function requireOperations(options: ReadToolOptions | undefined): ReadOperations {
	const operations = options?.operations;
	if (operations === undefined) {
		throw new Error('read tool: 浏览器没有默认文件系统，请在 options.operations 注入 ReadOperations（D5）');
	}
	return operations;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;   // 32768：一次展开的实参上限内，避免 String.fromCharCode 逐字节调用
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/** 共享执行体：`cwd` 已解析好（定义件传 `ctx?.cwd`，工厂件传构造期 cwd）。 */
async function executeRead(
	cwd: string,
	input: ReadToolInput,
	signal: AbortSignal | undefined,
	operations: ReadOperations,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
	throwIfAborted(signal);
	const absolutePath = await resolveReadPathAsync(input.path, cwd, (path) => operations.access(path));
	throwIfAborted(signal);
	// 与上游一致：解析完再显式确认一次可读（变体全不中时会回退未校验的原路径）
	await operations.access(absolutePath);
	throwIfAborted(signal);

	const mimeType = operations.detectImageMimeType ? await operations.detectImageMimeType(absolutePath) : undefined;
	if (mimeType) {
		const bytes = await operations.readFile(absolutePath);
		throwIfAborted(signal);
		// D6：只嗅探、不缩放；data 是原字节的 base64
		return {
			content: [
				{ type: 'text', text: `Read image file [${mimeType}]` },
				{ type: 'image', data: bytesToBase64(bytes), mimeType },
			],
			details: undefined,
		};
	}

	const textContent = _decoder.decode(await operations.readFile(absolutePath));
	throwIfAborted(signal);
	const allLines = textContent.split('\n');
	const totalFileLines = allLines.length;
	const startLine = input.offset ? Math.max(0, input.offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new FileError('invalid', `Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (input.limit !== undefined) {
		const endLine = Math.min(startLine + input.limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join('\n');
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join('\n');
	}
	const truncation = truncateHead(selectedContent);
	let outputText: string;
	let details: ReadToolDetails | undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(utf8ByteLength(allLines[startLine]));
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation };
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === 'lines') {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		outputText = truncation.content;
	}
	return { content: [{ type: 'text', text: outputText }], details };
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const operations = requireOperations(options);
	return {
		name: 'read',
		label: 'read',
		description: readToolDescription,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		execute: (toolCallId, input, signal, _onUpdate, ctx) => executeRead(ctx?.cwd || cwd, input, signal, operations),
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	const operations = requireOperations(options);
	return {
		name: 'read',
		label: 'read',
		description: readToolDescription,
		parameters: readSchema,
		execute: (toolCallId, input, signal, _onUpdate) => executeRead(cwd, input, signal, operations),
	};
}
