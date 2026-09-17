// src/tools/glob-tool.ts —— Glob 工具（Task 6；spec §3.3 表第六行，spice 无基线，新写）。
// 匹配用 picomatch（micromatch 语义；spec §3.4 的第三方理由：glob 事实标准、MIT、零传递依赖）。
// 语义差异写进 description：`*`/`?` 不跨 `/`，`**` 匹配零或多层目录，前导通配不匹配点文件（同 bash 默认）。
// 输出：相对 cwd 的文件路径、按名排序；只返回文件（目录由 Ls 负责）。
import picomatch from 'picomatch';
import { type Static, Type } from 'typebox';
import { FileError, type AgentTool } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import { resolveToCwd } from './path-utils';
import { contextFor, displayPath, listTree, statPath, textResult, throwIfAborted } from './fs-ops';

const globSchema = Type.Object({
	pattern: Type.String({ description: 'Glob pattern matched against file paths relative to `path`, e.g. "**/*.ts". `*` and `?` do not cross "/", `**` matches zero or more directories, and a leading wildcard does not match dotfiles.' }),
	path: Type.Optional(Type.String({ description: 'Base directory to search (relative to cwd or absolute). Default: cwd.' })),
});

export type GlobToolInput = Static<typeof globSchema>;

/** 结果的 details 为空：匹配结果本身就在 content 里 */
export type GlobToolDetails = Record<string, never>;

export interface GlobToolOptions {
	fs: BrowserFileSystem;
	/** 相对路径基准（默认 fs.cwd） */
	cwd?: string;
}

export function createGlobTool(opts: GlobToolOptions): AgentTool<typeof globSchema, GlobToolDetails> {
	const { fs } = opts;
	const cwd = opts.cwd ?? fs.cwd;
	return {
		name: 'Glob',
		label: 'Glob',
		description: 'Find files by glob pattern (matched against paths relative to the searched directory). Returns matching file paths relative to cwd, sorted by name. Directories are not returned (use Ls for directories).',
		parameters: globSchema,
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			const context = contextFor(signal);
			const base = resolveToCwd(input.path ?? '.', cwd);
			const baseInfo = await statPath(fs, base, context);
			if (baseInfo.kind !== 'directory') throw new FileError('not_directory', `Not a directory: ${input.path ?? base}`, base);
			const isMatch = compileGlob(input.pattern);
			const matched = (await listTree(fs, base, context))
				.filter((e) => e.kind !== 'directory' && isMatch(displayPath(e.path, base)));
			if (matched.length === 0) return textResult('No files matched.');
			return textResult(matched.map((e) => displayPath(e.path, cwd)).join('\n'));
		},
	};
}

function compileGlob(pattern: string): (input: string) => boolean {
	try {
		return picomatch(pattern);
	} catch (e) {
		throw new FileError('invalid', `Invalid glob pattern: ${(e as Error).message}`);
	}
}
