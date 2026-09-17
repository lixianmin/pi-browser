// src/tools/ls-tool.ts —— Ls 工具（Task 6；spec §3.3 表第五行，spice 无基线，新写）。
// 语义：单层默认、`recursive` 出整棵子树；目录带尾斜杠；条目按名排序（码点序，输出可复现）；
// 路径显示相对 cwd（与 Grep/Glob 一致）。空目录给显式文案，避免模型把「空输出」当工具失败。
import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import { resolveToCwd } from './path-utils';
import { contextFor, displayPath, listChildren, listTree, statPath, textResult, throwIfAborted } from './fs-ops';

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: 'Directory or file to list (relative to cwd or absolute). Default: cwd.' })),
	recursive: Type.Optional(Type.Boolean({ description: 'List the whole subtree instead of direct children only (default: false).' })),
});

export type LsToolInput = Static<typeof lsSchema>;

/** 结果的 details 为空：条目本身就在 content 里 */
export type LsToolDetails = Record<string, never>;

export interface LsToolOptions {
	fs: BrowserFileSystem;
	/** 相对路径基准（默认 fs.cwd） */
	cwd?: string;
}

export function createLsTool(opts: LsToolOptions): AgentTool<typeof lsSchema, LsToolDetails> {
	const { fs } = opts;
	const cwd = opts.cwd ?? fs.cwd;
	return {
		name: 'Ls',
		label: 'Ls',
		description: 'List a directory: direct children by default (directories suffixed with "/"), the whole subtree with recursive=true. Entries are sorted by name and paths are shown relative to cwd.',
		parameters: lsSchema,
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			const context = contextFor(signal);
			const root = resolveToCwd(input.path ?? '.', cwd);
			const info = await statPath(fs, root, context);
			if (info.kind !== 'directory') return textResult(displayPath(root, cwd));
			const entries = input.recursive ? await listTree(fs, root, context) : await listChildren(fs, root, context);
			if (entries.length === 0) return textResult('(empty directory)');
			const lines = entries.map((e) => `${displayPath(e.path, cwd)}${e.kind === 'directory' ? '/' : ''}`);
			return textResult(lines.join('\n'));
		},
	};
}
