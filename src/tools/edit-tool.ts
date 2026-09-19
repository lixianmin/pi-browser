// src/tools/edit-tool.ts —— Edit 工具（Task 5；spec §3.3 表第三行）。
// 平移源：spice `packages/harness/src/agent/tools/EditTool.ts`（上游 pi-coding-agent `core/tools/edit.ts` 简化版）：
// 一次调用多替换、LF 归一化 + 行尾保留 + BOM 剥离 + fuzzy 兜底、失败抛具体错误、结果出 display diff + patch。
// 偏离（spec §3.3）：① 数据源 registry → fs；② 删 Resource.editable 门（通用 fs 无「可编辑资源」概念，
// 能不能写由 fs 决定）；③ 删 spice 只读路径白名单（同 path-utils.ts）；④ 无 replaceAll（spice 注明 YAGNI，沿用）。
import { type Static, Type } from 'typebox';
import { FileError, type AgentTool } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import { resolveToCwd } from './path-utils';
import {
	applyEditsToNormalizedContent, detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, splitBom,
	type Edit as DiffEdit,
} from './edit-diff';
import { contextFor, readText, textResult, throwIfAborted, writeText } from './fs-ops';

const replaceEditSchema = Type.Object({
	oldText: Type.String({ description: 'Exact text for one targeted replacement. Must be unique in the original file and must not overlap with any other edits[].oldText in the same call.' }),
	newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
});

const editSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to edit (relative to cwd or absolute).' }),
	edits: Type.Array(replaceEditSchema, { description: 'One or more targeted replacements. Each edits[].oldText is matched against the original file (not after earlier edits). Do not emit overlapping or nested edits; if two changes touch the same block, merge them into one edit instead.' }),
});

export type EditToolInput = Static<typeof editSchema>;

/** 工具结果 details：content 只放给模型的文本，结构化信息（diff）进 details */
export interface EditToolDetails {
	diff: string;
	patch: string;
	firstChangedLine: number | undefined;
}

export interface EditToolOptions {
	fs: BrowserFileSystem;
	/** 相对路径基准（默认 fs.cwd） */
	cwd?: string;
}

export function createEditTool(opts: EditToolOptions): AgentTool<typeof editSchema, EditToolDetails> {
	const { fs } = opts;
	const cwd = opts.cwd ?? fs.cwd;
	return {
		name: 'edit',
		label: 'edit',
		description: 'Edit a file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes touch the same block, merge them into one edit. Do not pad with large unchanged regions to connect distant changes.',
		parameters: editSchema,
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			if (!input.edits.length) throw new FileError('invalid', 'Edit requires at least one entry in edits[].');
			const absolutePath = resolveToCwd(input.path, cwd);
			const context = contextFor(signal);
			const raw = await readText(fs, absolutePath, context);
			throwIfAborted(signal);
			const { bom, text: content } = splitBom(raw);
			const originalEnding = detectLineEnding(content);
			const normalized = normalizeToLF(content);
			const editsAsDiff: DiffEdit[] = input.edits.map((e) => ({ oldText: e.oldText, newText: e.newText }));
			const { baseContent, newContent } = applyEditsToNormalizedContent(normalized, editsAsDiff, input.path);
			const finalContent = bom + restoreLineEndings(newContent, originalEnding);
			await writeText(fs, absolutePath, finalContent, context);
			throwIfAborted(signal);
			const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);
			// Simple unified patch（pi 用 jsdiff 库；spice 自写简化版）
			const patch = `--- ${input.path}\n+++ ${input.path}\n@@\n${diff}\n`;
			return textResult(`Successfully replaced ${input.edits.length} block(s) in ${input.path}.`, { diff, patch, firstChangedLine });
		},
	};
}
