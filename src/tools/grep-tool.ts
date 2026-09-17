// src/tools/grep-tool.ts —— Grep 工具（Task 6；spec §3.3 表第四行）。
// 基线 = spice `packages/harness/src/agent/tools/GrepTool.ts` 的 schema 与输出格式，逐字保留的部分：
//   `file:line: text` 命中行、`file-line- text` 上下文行、单行 500 字符截断、匹配数 limit 与 50KB 截断
//   的 notice 文案（`N matches limit reached. Use limit=2N ...`）。
// 故意偏离 spice（spec §3.3 明示）：spice 只扫 DEFAULT_GREP_PATHS 白名单且非递归（spice 域特化）；
//   本工具递归全目录 + 新增 `include` glob 过滤（相对被搜目录匹配）。
// 实现：listDir 栈式遍历（fs-ops.listTree）+ readTextFile；读不动的文件（二进制）跳过——同 spice 跳过未注册资源的语义。
import picomatch from 'picomatch';
import { type Static, Type } from 'typebox';
import { FileError, type AgentTool, type AgentToolResult, type Context } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine, type TruncationResult } from './truncate';
import { resolveToCwd } from './path-utils';
import { contextFor, displayPath, listTree, readText, statPath, textResult, throwIfAborted } from './fs-ops';

const grepSchema = Type.Object({
	pattern: Type.String({ description: 'Search pattern (regex by default; set literal=true for plain string).' }),
	path: Type.Optional(Type.String({ description: 'File or directory to search (relative to cwd or absolute). Default: cwd (whole workspace).' })),
	include: Type.Optional(Type.String({ description: 'Glob filter applied to each file path relative to the searched directory, e.g. "**/*.ts" (only for directory searches). Default: all files.' })),
	ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search (default: false).' })),
	literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as literal string (default: false → regex).' })),
	context: Type.Optional(Type.Number({ description: 'Lines of context before/after each match (default: 0).' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of matches (default: 100).' })),
});

export type GrepToolInput = Static<typeof grepSchema>;

const DEFAULT_LIMIT = 100;

/** 工具结果 details：content 只放给模型的文本，结构化信息进 details */
export interface GrepToolDetails {
	matchLimitReached: number | undefined;
	truncation: TruncationResult | undefined;
	linesTruncated: boolean;
}

export interface GrepToolOptions {
	fs: BrowserFileSystem;
	/** 相对路径基准（默认 fs.cwd） */
	cwd?: string;
}

export function createGrepTool(opts: GrepToolOptions): AgentTool<typeof grepSchema, GrepToolDetails> {
	const { fs } = opts;
	const cwd = opts.cwd ?? fs.cwd;
	return {
		name: 'Grep',
		label: 'Grep',
		description: `Search files for a pattern. Recursively searches the given path (default: the whole workspace) and returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB whichever is hit first. Long lines truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		parameters: grepSchema,
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			const context = contextFor(signal);
			// 正则/glob 先编译：语法错的输入不该等扫完目录才报（也保证扫描循环里只剩纯匹配）
			const matcher = createMatcher(input.pattern, input.ignoreCase, input.literal);
			const includeMatch = input.include === undefined ? undefined : compileGlob(input.include);
			const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
			const targets = await resolveTargets(fs, input, cwd, context, includeMatch);
			const found = await scanTargets(fs, targets, { matcher, limit, contextLines: Math.max(0, input.context ?? 0) }, cwd, context, signal);
			throwIfAborted(signal);
			return formatScanResult(found, limit);
		},
	};
}

interface GrepMatcher {
	matchesLine(line: string): boolean;
	/** 全局正则的 `lastIndex` 在 test() 后前进：逐行复位（spice 同款），否则会漏行 */
	reset(): void;
}

function createMatcher(pattern: string, ignoreCase: boolean | undefined, literal: boolean | undefined): GrepMatcher {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return { matchesLine: (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle), reset: () => {} };
	}
	const re = compilePattern(pattern, ignoreCase);
	return { matchesLine: (line) => re.test(line), reset: () => { re.lastIndex = 0; } };
}

/** 搜索目标（绝对路径，按目录树顺序）：文件路径 → 自身；目录 → 递归全树，`include` 相对被搜目录过滤 */
async function resolveTargets(
	fs: BrowserFileSystem,
	input: GrepToolInput,
	cwd: string,
	context: Context,
	includeMatch: ((input: string) => boolean) | undefined,
): Promise<string[]> {
	const root = resolveToCwd(input.path ?? '.', cwd);
	const rootInfo = await statPath(fs, root, context);
	if (rootInfo.kind !== 'directory') return [root];
	return (await listTree(fs, root, context))
		.filter((e) => e.kind !== 'directory')
		.filter((e) => includeMatch === undefined || includeMatch(displayPath(e.path, root)))
		.map((e) => e.path);
}

interface ScanOptions {
	matcher: GrepMatcher;
	limit: number;
	contextLines: number;
}

interface ScanResult {
	lines: string[];
	matchCount: number;
	matchLimitReached: number | undefined;
	linesTruncated: boolean;
}

/** 逐文件扫描：批次结果累积到 `found`（读不动的文件跳过，不打断整次搜索） */
async function scanTargets(
	fs: BrowserFileSystem,
	targets: string[],
	options: ScanOptions,
	cwd: string,
	context: Context,
	signal: AbortSignal | undefined,
): Promise<ScanResult> {
	const found: ScanResult = { lines: [], matchCount: 0, matchLimitReached: undefined, linesTruncated: false };
	for (const target of targets) {
		throwIfAborted(signal);
		let text: string;
		try {
			text = await readText(fs, target, context);
		} catch {
			continue;   // 读不动（二进制等）的文件跳过，不打断整次搜索
		}
		scanFile(found, target, text, options, cwd);
		if (found.matchLimitReached !== undefined) break;
	}
	return found;
}

/** 单文件扫描：命中行/上下文行按 spice 格式累积（`file:line: text` 与 `file-line- text`） */
function scanFile(found: ScanResult, target: string, text: string, options: ScanOptions, cwd: string): void {
	const { matcher, limit, contextLines } = options;
	const rel = displayPath(target, cwd);
	const fileLines = text.replace(/\r\n/g, '\n').split('\n');
	for (let i = 0; i < fileLines.length; i++) {
		if (matcher.matchesLine(fileLines[i])) {
			if (found.matchCount >= limit) {
				found.matchLimitReached = limit;
				return;
			}
			found.matchCount++;
			const lineNum = i + 1;
			const start = contextLines > 0 ? Math.max(1, lineNum - contextLines) : lineNum;
			const end = contextLines > 0 ? Math.min(fileLines.length, lineNum + contextLines) : lineNum;
			for (let k = start; k <= end; k++) {
				const truncated = truncateLine(fileLines[k - 1] ?? '');
				if (truncated.wasTruncated) found.linesTruncated = true;
				found.lines.push(`${k === lineNum ? `${rel}:${k}:` : `${rel}-${k}-`} ${truncated.text}`);
			}
		}
		matcher.reset();
	}
}

function formatScanResult(found: ScanResult, limit: number): AgentToolResult<GrepToolDetails> {
	const truncation = truncateHead(found.lines.join('\n'));
	let content = truncation.content;
	const notices: string[] = [];
	if (found.matchLimitReached !== undefined) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern.`);
	if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached.`);
	if (found.linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use Read to see full lines.`);
	if (notices.length) content += `\n\n[${notices.join(' ')}]`;
	return textResult(found.matchCount === 0 ? 'No matches found.' : content, {
		matchLimitReached: found.matchLimitReached,
		truncation: truncation.truncated ? truncation : undefined,
		linesTruncated: found.linesTruncated,
	});
}

function compilePattern(pattern: string, ignoreCase: boolean | undefined): RegExp {
	try {
		return new RegExp(pattern, ignoreCase ? 'gmi' : 'gm');
	} catch (e) {
		throw new FileError('invalid', `Invalid regex pattern: ${(e as Error).message}`);
	}
}

function compileGlob(pattern: string): (input: string) => boolean {
	try {
		return picomatch(pattern);
	} catch (e) {
		throw new FileError('invalid', `Invalid include glob: ${(e as Error).message}`);
	}
}
