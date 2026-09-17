// src/tools/fs-ops.ts —— 七个工具与 pi `FileSystem` 之间的唯一适配层（Task 5）。
//
// 为什么需要：pi FileSystem 的契约是「不抛、失败编码进 Result<_, FileError>」，而工具契约是
// 「失败即 throw，错误对象携带 FileErrorCode」（spec §3.3）。两套契约的换算只在这里做一次，
// 工具各自 assert `ok` 会散成七份。顺带收敛三件七工具共用的东西：abort 检查、cwd 相对路径显示、目录树遍历。
import {
	BACKGROUND_CONTEXT, FileError, withAbortSignal,
	type AgentToolResult, type Context, type FileInfo, type Result,
} from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import { normalizePath } from '../env/path';

/** 工具结果包装：pi 的 content 是块数组，details 是给 UI/日志的结构化信息（缺省 {}） */
export function textResult<TDetails extends object>(text: string, details?: TDetails): AgentToolResult<TDetails> {
	return { content: [{ type: 'text', text }], details: (details ?? ({} as TDetails)) };
}

/** 工具的 context：带 signal 时派生出可取消 context（exec 的 abort 路径靠 context.abortSignal 传导） */
export function contextFor(signal?: AbortSignal): Context {
	return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
}

/** 工具调用前的 abort 检查（fs 后端不感知 signal，只能由工具自查；与 spice 同语义） */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new FileError('aborted', 'Operation aborted');
}

/** Result → 抛：fs 失败原样抛出（code 由后端判定，工具不重写，避免把 not_found 洗成 unknown） */
function unwrap<T>(result: Result<T, FileError>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

export async function readText(fs: BrowserFileSystem, absolutePath: string, context: Context): Promise<string> {
	return unwrap(await fs.readTextFile(absolutePath, context));
}

export async function writeText(fs: BrowserFileSystem, absolutePath: string, content: string, context: Context): Promise<void> {
	unwrap(await fs.writeFile(absolutePath, content, context));
}

export async function statPath(fs: BrowserFileSystem, absolutePath: string, context: Context): Promise<FileInfo> {
	return unwrap(await fs.fileInfo(absolutePath, context));
}

/** 目录直属子项，按名排序（localeCompare 随 locale 漂 → 用码点比较，输出可复现） */
export async function listChildren(fs: BrowserFileSystem, absoluteDir: string, context: Context): Promise<FileInfo[]> {
	const entries = unwrap(await fs.listDir(absoluteDir, context));
	return entries.sort(compareByName);
}

/** 深度优先遍历（目录先于其子项），递归用显式栈遍历同一份 listChildren 排序结果 */
export async function listTree(fs: BrowserFileSystem, rootDir: string, context: Context): Promise<FileInfo[]> {
	const out: FileInfo[] = [];
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await listChildren(fs, dir, context)) {
			out.push(entry);
			if (entry.kind === 'directory') await visit(entry.path);
		}
	};
	await visit(rootDir);
	return out;
}

/** 工具输出里给模型的路径：cwd 之下用相对路径（`src/a.ts`），之外保持绝对 */
export function displayPath(absolutePath: string, cwd: string): string {
	const root = normalizePath(cwd);
	if (root === '/') return absolutePath.slice(1);
	if (absolutePath === root) return '.';
	return absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : absolutePath;
}

function compareByName(a: FileInfo, b: FileInfo): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
