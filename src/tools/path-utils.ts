// src/tools/path-utils.ts —— 工具侧路径解析（Task 9 / P2a-2）。
// 转写源：pi-coding-agent@1.0.0 dist/core/tools/path-utils.js（5 导出）。
//
// 三处浏览器偏离（spec §3.4 D5 同款；P6 落 README「平台偏差」）：
//   ① 上游 pathExists 直接吃 node:fs/promises 的 `access`、resolveReadPath 用 `accessSync`。
//      浏览器没有全局/同步 fs：存在性改成调用方注入的 `access` 谓词（与上游 `ReadOperations.access`
//      同契约：成功 resolve、失败 reject）；同步 resolveReadPath 因此退化为纯解析、不探 macOS 变体。
//   ② expandPath 不做 `~` → home 展开（浏览器无 home 概念），`~` 原样保留成虚拟路径。
//   ③ 路径归一走本仓纯 JS 的 normalizePath（env/path），不用 node:path。

import { normalizePath } from '../env/path';

const NARROW_NO_BREAK_SPACE = '\u202F';
/** 上游 utils/paths.js 的同一张表（Unicode 空格 → 普通空格）。 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 调用方注入的「可读性」谓词：成功 resolve、失败 reject（与上游 `ReadOperations.access` 同契约）。 */
export type AccessPath = (absolutePath: string) => Promise<void>;

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

/** macOS 以 NFD（分解）形式存文件名，试着把用户输入转成 NFD。 */
function tryNFDVariant(filePath: string): string {
	return filePath.normalize('NFD');
}

/** macOS 截图名用 U+2019（右单引号），用户通常打 U+0027。 */
function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, '\u2019');
}

/** 上游同名：存在性检查。上游吃 node:fs 的 access，浏览器版吃注入谓词（见文件头 ①）。 */
export async function pathExists(filePath: string, access: AccessPath): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	const normalized = filePath.replace(UNICODE_SPACES, ' ');
	return normalized.startsWith('@') ? normalized.slice(1) : normalized;
}

/** 相对路径解析为绝对归一化路径（基于 cwd）。 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return normalizePath(expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`);
}

/**
 * 上游同步版用 `accessSync` 探测 macOS 变体；浏览器没有同步 fs（没有同步谓词可用），
 * 这里退化为纯解析。需要变体探测的调用方走 `resolveReadPathAsync`。
 */
export function resolveReadPath(filePath: string, cwd: string): string {
	return resolveToCwd(filePath, cwd);
}

export async function resolveReadPathAsync(filePath: string, cwd: string, access: AccessPath): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);
	if (await pathExists(resolved, access)) return resolved;
	// macOS AM/PM 变体（AM/PM 前的空格是窄不换行空格 U+202F）
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant, access))) return amPmVariant;
	// NFD 变体（macOS 以 NFD 存文件名）
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant, access))) return nfdVariant;
	// 弯引号变体（macOS 截图名用 U+2019）
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant, access))) return curlyVariant;
	// NFD + 弯引号组合（法语 macOS 截图如 "Capture d'écran"）
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant, access))) return nfdCurlyVariant;
	return resolved;
}
