// src/tools/grep-tool.ts —— Grep 工具（P2c Task 14）。
// 契约面 1:1 于 pi-coding-agent@1.0.0 dist/core/tools/grep.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / GrepOperations / GrepToolDetails / 两导出形状；输出与 notices 文案逐字上游。
// 实现体自持：上游把目录遍历外包给 ripgrep，`GrepOperations` 只有 {isDirectory, readFile}、没有遍历接缝，
// 所以本仓在 `GrepToolOptions` 上额外收一个 `fs`（仅 grep；人类裁决 2026-10-02），遍历用本仓 listTree。
// 平台偏差：上游文案声明 `respects .gitignore`，本仓遍历不读 .gitignore（P6 README 记）。
// 错误仍是带 FileErrorCode 的 FileError（spec §3.3）：非法正则/glob → invalid，路径不存在 → not_found。

import picomatch from './picomatch-typed';
import { type Static, Type } from 'typebox';
import type { Context } from '../env/context';
import { FileError } from '@earendil-works/pi-durable/env';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import type { ToolDefinition } from '../extensions/tool';
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine, type TruncationResult } from './truncate';
import { resolveToCwd } from './path-utils';
import { contextFor, displayPath, listTree, readText, statPath, throwIfAborted } from './fs-ops';

const DEFAULT_LIMIT = 100;

const grepSchema = Type.Object({
	pattern: Type.String({ description: 'Search pattern (regex or literal string)' }),
	path: Type.Optional(Type.String({ description: 'Directory or file to search (default: current directory)' })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search (default: false)' })),
	literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as literal string instead of regex (default: false)' })),
	context: Type.Optional(Type.Number({ description: 'Number of lines to show before and after each match (default: 0)' })),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of matches to return (default: 100)' })),
});

export const grepToolSystemPromptContribution = {
	snippet: 'Search file contents for patterns (respects .gitignore)',
	guidelines: [],
} as const;

const grepToolDescription = `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`;

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/** 可插拔的搜索操作（对齐上游 `GrepOperations`）。 */
export interface GrepOperations {
	/** 路径是否是目录；路径不存在时 throw */
	isDirectory(absolutePath: string): Promise<boolean> | boolean;
	/** 读文件内容（上下文行用） */
	readFile(absolutePath: string): Promise<string> | string;
}

export interface GrepToolOptions {
	/** 覆盖上游两条缝；缺省由本仓基于 `fs` 实现 */
	operations?: GrepOperations;
	/** 遍历源（本仓扩展：上游 grep 把遍历外包给 rg，浏览器没有） */
	fs: BrowserFileSystem;
}

function requireFs(options: GrepToolOptions | undefined): BrowserFileSystem {
	const fs = options?.fs;
	if (fs === undefined) {
		throw new Error('grep tool: 浏览器没有默认文件系统，请在 options.fs 注入 BrowserFileSystem（D5；上游 grep 把遍历外包给 ripgrep）');
	}
	return fs;
}

function defaultOperations(fs: BrowserFileSystem, context: Context): GrepOperations {
	return {
		isDirectory: async (absolutePath) => (await statPath(fs, absolutePath, context)).kind === 'directory',
		readFile: (absolutePath) => readText(fs, absolutePath, context),
	};
}

interface GrepMatcher {
	matchesLine(line: string): boolean;
	/** 全局正则的 `lastIndex` 在 test() 后前进：逐行复位（上游同款），否则会漏行 */
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

/** 上游 `formatPath`：目录搜索给相对搜索根的 posix 路径，单文件搜索给 basename。 */
function formatGrepPath(filePath: string, searchPath: string, searchIsDirectory: boolean): string {
	if (searchIsDirectory) {
		const relative = displayPath(filePath, searchPath);
		if (relative !== '.' && relative !== '' && !relative.startsWith('..')) return relative;
	}
	return filePath.slice(filePath.lastIndexOf('/') + 1);
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

async function scanTargets(
	operations: GrepOperations,
	targets: string[],
	options: ScanOptions,
	searchPath: string,
	searchIsDirectory: boolean,
	signal: AbortSignal | undefined,
): Promise<ScanResult> {
	const found: ScanResult = { lines: [], matchCount: 0, matchLimitReached: undefined, linesTruncated: false };
	for (const target of targets) {
		throwIfAborted(signal);
		let text: string;
		try {
			text = await operations.readFile(target);
		} catch {
			continue;   // 读不动（二进制等）的文件跳过，不打断整次搜索
		}
		scanFile(found, target, text, options, searchPath, searchIsDirectory);
		if (found.matchLimitReached !== undefined) break;
	}
	return found;
}

/** 单文件扫描：命中行 `path:line: text`、上下文行 `path-line- text`（上游同款） */
function scanFile(
	found: ScanResult,
	target: string,
	text: string,
	options: ScanOptions,
	searchPath: string,
	searchIsDirectory: boolean,
): void {
	const { matcher, limit, contextLines } = options;
	const rel = formatGrepPath(target, searchPath, searchIsDirectory);
	// 与上游 `getFileLines` 一致：CRLF 与单 CR 都当行分隔符
	const fileLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	for (let i = 0; i < fileLines.length; i++) {
		if (matcher.matchesLine(fileLines[i])) {
			found.matchCount++;
			// 上游在第 limit 条命中就置位（它 kill 掉 rg，不判断后面还有没有）
			const limitReached = found.matchCount >= limit;
			const lineNum = i + 1;
			const start = contextLines > 0 ? Math.max(1, lineNum - contextLines) : lineNum;
			const end = contextLines > 0 ? Math.min(fileLines.length, lineNum + contextLines) : lineNum;
			for (let k = start; k <= end; k++) {
				const truncated = truncateLine((fileLines[k - 1] ?? '').replace(/\r/g, ''));
				if (truncated.wasTruncated) found.linesTruncated = true;
				found.lines.push(`${k === lineNum ? `${rel}:${k}:` : `${rel}-${k}-`} ${truncated.text}`);
			}
			if (limitReached) {
				found.matchLimitReached = limit;
				return;
			}
		}
		matcher.reset();
	}
}

/** 输出与 notices 逐字上游：`. ` 连接、无尾句号、`Use read tool …`（read 小写）。 */
function formatScanResult(found: ScanResult, limit: number): AgentToolResult<GrepToolDetails | undefined> {
	if (found.matchCount === 0) {
		return { content: [{ type: 'text', text: 'No matches found' }], details: undefined };
	}
	// 没有行数上限：匹配数已经由 limit 封顶（上游同款）
	const truncation = truncateHead(found.lines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
	let content = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (found.matchLimitReached !== undefined) {
		notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
		details.matchLimitReached = limit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (found.linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) content += `\n\n[${notices.join('. ')}]`;
	return { content: [{ type: 'text', text: content }], details: Object.keys(details).length > 0 ? details : undefined };
}

async function executeGrep(
	fs: BrowserFileSystem,
	customOperations: GrepOperations | undefined,
	cwd: string,
	input: GrepToolInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GrepToolDetails | undefined>> {
	throwIfAborted(signal);
	const context = contextFor(signal);
	const operations = customOperations ?? defaultOperations(fs, context);
	// 正则/glob 先编译：语法错的输入不该等扫完目录才报
	const matcher = createMatcher(input.pattern, input.ignoreCase, input.literal);
	const globMatch = input.glob === undefined ? undefined : compileGlob(input.glob, cwd);
	const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
	const searchPath = resolveToCwd(input.path ?? '.', cwd);
	const isDirectory = await operations.isDirectory(searchPath);
	const targets = isDirectory
		? (await listTree(fs, searchPath, context))
			.filter((entry) => entry.kind !== 'directory')
			.filter((entry) => globMatch === undefined || globMatch(entry.path, entry.name))
			.map((entry) => entry.path)
		: [searchPath];
	const found = await scanTargets(operations, targets, { matcher, limit, contextLines: Math.max(0, input.context ?? 0) }, searchPath, isDirectory, signal);
	throwIfAborted(signal);
	return formatScanResult(found, limit);
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const fs = requireFs(options);
	const customOperations = options?.operations;
	return {
		name: 'grep',
		label: 'grep',
		description: grepToolDescription,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		execute: (toolCallId, input, signal, _onUpdate, ctx) => executeGrep(fs, customOperations, ctx?.cwd || cwd, input, signal),
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	const fs = requireFs(options);
	const customOperations = options?.operations;
	return {
		name: 'grep',
		label: 'grep',
		description: grepToolDescription,
		parameters: grepSchema,
		execute: (toolCallId, input, signal, _onUpdate) => executeGrep(fs, customOperations, cwd, input, signal),
	};
}

function compilePattern(pattern: string, ignoreCase: boolean | undefined): RegExp {
	try {
		return new RegExp(pattern, ignoreCase ? 'gmi' : 'gm');
	} catch (e) {
		throw new FileError('invalid', `Invalid regex pattern: ${(e as Error).message}`);
	}
}

/**
 * `glob` 的匹配语义 = **rg 的 `--glob`**（人类裁决 2026-10-02：能力与 pi-coding-agent 对齐）。
 * 上游把 pattern 原样交给 `rg --glob`，本仓没有 rg 进程，所以按 rg 的规则复刻（rg 15.2.0 实测钉死）：
 *   · pattern **不含**斜杠 → 对 **basename** 匹配（任意深度都算；实测 pattern `*.ts` 命中
 *     `./a.ts` / `./src/a.ts` / `./src/.gen/b.ts` 三个文件）；
 *   · pattern **含**斜杠 → 对 **相对 cwd** 的路径匹配（不是相对搜索根！实测：cwd=`/tmp`、搜索根=`rgtest` 时，
 *     只有 `rgtest/**` 开头的 pattern 才命中）；
 *   · 上游带 `--hidden`，通配符吃点号（实测 `src` 下一层的通配能命中 `src/.gen/b.ts`）→ `dot: true`。
 * 输出路径是另一回事：仍然相对**搜索根**（上游 formatPath），不要与匹配基准混为一谈。
 *
 * 已知偏差（不追平）：pattern 带点斜杠前缀时 rg 不匹配（实测返 0 条），本仓会匹配 ——
 * 朝着「多给结果」的方向偏，比让模型白跑一趟安全。
 */
function compileGlob(pattern: string, cwd: string): (absolutePath: string, name: string) => boolean {
	let matches: (input: string) => boolean;
	try {
		matches = picomatch(pattern, { dot: true });
	} catch (e) {
		throw new FileError('invalid', `Invalid glob pattern: ${(e as Error).message}`);
	}
	const byBasename = !pattern.includes('/');
	return (absolutePath, name) => matches(byBasename ? name : displayPath(absolutePath, cwd));
}
