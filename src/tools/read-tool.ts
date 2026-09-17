// src/tools/read-tool.ts —— Read 工具（Task 5；spec §3.3 表第一行）。
// 平移源：spice `packages/harness/src/agent/tools/ReadTool.ts`（上游 pi-coding-agent `core/tools/read.ts` 简化版）：
// offset/limit 分页、`truncateHead` 双阈值截断、continuation 文案逐字保留（LLM 依赖该语义）、abort 透传。
// 唯一偏离：数据源 registry → BrowserFileSystem（`resource.read()` → `fs.readTextFile`，缺文件改为后端给的 not_found）。
import { type Static, Type } from 'typebox';
import { FileError, type AgentTool } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from './truncate';
import { resolveToCwd } from './path-utils';
import { contextFor, readText, textResult, throwIfAborted } from './fs-ops';

const readSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to read (relative to cwd or absolute).' }),
	offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed).' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read.' })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncated: boolean;
}

export interface ReadToolOptions {
	fs: BrowserFileSystem;
	/** 相对路径基准（默认 fs.cwd） */
	cwd?: string;
}

export function createReadTool(opts: ReadToolOptions): AgentTool<typeof readSchema, ReadToolDetails> {
	const { fs } = opts;
	const cwd = opts.cwd ?? fs.cwd;
	return {
		name: 'Read',
		label: 'Read',
		description: `Read the contents of a text file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB whichever is hit first. Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(
			_toolCallId: string,
			input: ReadToolInput,
			signal?: AbortSignal,
		) {
			throwIfAborted(signal);
			const absolutePath = resolveToCwd(input.path, cwd);
			const content = await readText(fs, absolutePath, contextFor(signal));
			throwIfAborted(signal);
			const allLines = content.split('\n');
			const start = input.offset ? Math.max(0, input.offset - 1) : 0;
			if (start >= allLines.length) throw new FileError('invalid', `Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`);
			const userLimited = input.limit !== undefined;
			const requestedEnd = userLimited ? Math.min(start + input.limit!, allLines.length) : allLines.length;
			const slice = allLines.slice(start, requestedEnd);
			const truncated = truncateHead(slice.join('\n'));
			let out = truncated.content;
			if (truncated.truncated) {
				const nextOffset = start + truncated.outputLines + 1;
				out += `\n\n[Showing lines ${start + 1}-${start + truncated.outputLines} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
			} else if (userLimited && requestedEnd < allLines.length) {
				const nextOffset = requestedEnd + 1;
				out += `\n\n[${allLines.length - requestedEnd} more lines. Use offset=${nextOffset} to continue.]`;
			}
			return textResult(out, { truncated: truncated.truncated });
		},
	};
}
