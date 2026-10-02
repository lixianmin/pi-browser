// src/tools/edit-tool.ts —— Edit 工具（P2b Task 13）。
// 契约面 1:1 于 pi-coding-agent@1.0.0 dist/core/tools/edit.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / promptGuidelines / EditOperations / EditToolDetails / 两导出形状。
// 实现体自持：匹配/替换走 P2a 转写的 edit-diff（上游语义）；fs 由调用方注入（D5）。
// 不声明 `prepareArguments` / `withFileMutationQueue`（S6 §3.3：只留浏览器能兑现的字段；后者是实现体）。

import { type Static, Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool';
import { resolveToCwd } from './path-utils';
import {
	applyEditsToNormalizedContent, detectLineEnding, generateDiffString, generateUnifiedPatch, normalizeToLF, restoreLineEndings,
	type Edit as DiffEdit,
} from './edit-diff';
import { splitBom } from './text';
import { throwIfAborted } from './fs-ops';

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
	}),
	newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
});

const editSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
	edits: Type.Array(replaceEditSchema, {
		description: 'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
	}),
});

export const editToolSystemPromptContribution = {
	snippet: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
	guidelines: [
		'Use edit for precise changes (edits[].oldText must match exactly)',
		'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
		'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
		'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.',
	],
} as const;

const editToolDescription = 'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.';

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

/** 浏览器没有默认文件系统（D5）：缺省即响亮报错。 */
function requireOperations(options: EditToolOptions | undefined): EditOperations {
	const operations = options?.operations;
	if (operations === undefined) {
		throw new Error('edit tool: 浏览器没有默认文件系统，请在 options.operations 注入 EditOperations（D5）');
	}
	return operations;
}

/** 与上游 `Buffer.toString('utf-8')` 等价：`ignoreBOM: true` 表示不吞掉开头的 BOM（默认会吞）。 */
const _decoder = new TextDecoder('utf-8', { ignoreBOM: true });

async function executeEdit(
	cwd: string,
	input: EditToolInput,
	signal: AbortSignal | undefined,
	operations: EditOperations,
): Promise<AgentToolResult<EditToolDetails | undefined>> {
	throwIfAborted(signal);
	// 上游 `validateEditInput` 的文案
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
	}
	const absolutePath = resolveToCwd(input.path, cwd);
	await operations.access(absolutePath);
	throwIfAborted(signal);
	const rawContent = _decoder.decode(await operations.readFile(absolutePath));
	throwIfAborted(signal);
	const { bom, text: content } = splitBom(rawContent);
	const originalEnding = detectLineEnding(content);
	const normalizedContent = normalizeToLF(content);
	const editsAsDiff: DiffEdit[] = input.edits.map((e) => ({ oldText: e.oldText, newText: e.newText }));
	const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, editsAsDiff, input.path);
	throwIfAborted(signal);
	const finalContent = bom + restoreLineEndings(newContent, originalEnding);
	await operations.writeFile(absolutePath, finalContent);
	throwIfAborted(signal);
	const diffResult = generateDiffString(baseContent, newContent);
	const patch = generateUnifiedPatch(input.path, baseContent, newContent);
	return {
		content: [{ type: 'text', text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
		details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
	};
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined> {
	const operations = requireOperations(options);
	return {
		name: 'edit',
		label: 'edit',
		description: editToolDescription,
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		execute: (toolCallId, input, signal, _onUpdate, ctx) => executeEdit(ctx?.cwd ?? cwd, input, signal, operations),
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	const operations = requireOperations(options);
	return {
		name: 'edit',
		label: 'edit',
		description: editToolDescription,
		parameters: editSchema,
		execute: (toolCallId, input, signal, _onUpdate) => executeEdit(cwd, input, signal, operations),
	};
}
