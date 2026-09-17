// src/tools/edit-diff.ts —— Edit 工具 search/replace 核心（Task 5）。
// 平移源：spice `packages/harness/src/agent/edit-diff.ts`（上游是 pi-coding-agent `core/tools/edit-diff.ts`）。
// 偏离（两处，见计划 Task 5「三态」）：
//   ① 失败从 `Error` 改成 `FileError(code, ...)`——工具契约要求错误对象携带 FileErrorCode，
//      文案逐字不变（调用方按 code 分流，不再靠正则嗅探 message）；`_path` 参数因此被用起来。
//   ② 多命中错误并列每处命中行号（spec §3.3「多处命中报错并列位置」），spice 只有计数。
// 其余逐字平移：LF 归一化（保留原始行尾）、BOM 剥离、智能引号/Unicode 标点/全角空格 1-1 归一（fuzzy 兜底，
// offset 不变）、多次替换按「原始文件」匹配不增量、重复/重叠报错、display diff + unified patch 组装在工具侧。

import { FileError } from '@earendil-works/pi-agent-core';

export function detectLineEnding(content: string): '\r\n' | '\n' {
	const crlfIdx = content.indexOf('\r\n');
	const lfIdx = content.indexOf('\n');
	if (lfIdx === -1) return '\n';
	if (crlfIdx === -1) return '\n';
	return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
	return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export function splitBom(content: string): { bom: string; text: string } {
	if (content.charCodeAt(0) === 0xfeff) return { bom: '\ufeff', text: content.slice(1) };
	return { bom: '', text: content };
}

/** fuzzy 归一：smart quotes / Unicode 标点 / 全角空格（1-1 替换，原串下标不变）。
 * 不走 NFKC（改字符长度 + offset 漂移）和行 trim（offset 漂移）——只做 1-1 替换，
 * offset 在 fuzzy 与 original 完全一致。 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.replace(/[\u2018\u2019\u201a\u201b]/g, "'")
		.replace(/[\u201c\u201d\u201e\u201f]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, '-')
		.replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ');
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** 每处命中的 1-based 行号（只给「多命中」错误用：并列位置才知道该把 oldText 收窄到哪一行） */
function matchLineNumbers(haystack: string, needle: string): number[] {
	const lines: number[] = [];
	for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) {
		lines.push(countNewlines(haystack, idx) + 1);
	}
	return lines;
}

function countNewlines(text: string, upTo: number): number {
	let count = 0;
	for (let i = text.indexOf('\n'); i !== -1 && i < upTo; i = text.indexOf('\n', i + 1)) count++;
	return count;
}

interface MatchedEdit {
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/**
 * 定位一处 oldText：精确优先，未命中退 fuzzy 归一。多命中直接挖（并列每处执行号）。
 * fuzzy 归一只做 1-1 替换（smart quote/dash/space），字符串长度不变 → idx 在 fuzzy 与原串完全一致，
 * matchLength = oldText.length 可直接应用于原串（P2 修：不甩字）。
 */
function locateEdit(base: string, oldText: string, path: string): { matchIndex: number; matchLength: number } {
	const exact = base.indexOf(oldText);
	const usedFuzzy = exact === -1;
	const haystack = usedFuzzy ? normalizeForFuzzyMatch(base) : base;
	const needle = usedFuzzy ? normalizeForFuzzyMatch(oldText) : oldText;
	const matchIndex = usedFuzzy ? haystack.indexOf(needle) : exact;
	if (matchIndex === -1) throw new FileError('not_found', `Could not find edits[${oldText}] in file. The oldText must match exactly (or fuzzy-normalized).`, path);
	const occ = countOccurrences(haystack, needle);
	if (occ > 1) {
		throw new FileError('invalid', `Found ${occ} occurrences of edits[${oldText}] (lines ${matchLineNumbers(haystack, needle).join(', ')}). The text must be unique in the file.`, path);
	}
	return { matchIndex, matchLength: oldText.length };
}

/**
 * 一次调用内多次 search/replace。匹配在 LF 归一化 + BOM 剥离后的 content 上做。
 * - oldText 必须唯一匹配（精确优先，再 fuzzy 归一化）
 * - 不允许重叠
 * - newText 之间也避免重叠
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalized = edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) }));
	for (const e of normalized) {
		if (e.oldText.length === 0) throw new FileError('invalid', 'Edit oldText must not be empty', path);
	}

	// 匹配全在原始（base）串上做，不看已应用的结果：多替换不增量（与 spice/pi 一致）
	const baseForReplace = normalizedContent;
	const matched: MatchedEdit[] = normalized.map((e) => ({ ...locateEdit(baseForReplace, e.oldText, path), newText: e.newText }));

	matched.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matched.length; i++) {
		if (matched[i - 1].matchIndex + matched[i - 1].matchLength > matched[i].matchIndex) {
			throw new FileError('invalid', 'edits overlap; merge them into one or pick disjoint regions.', path);
		}
	}

	// 倒序应用，保证 offset 不偏移
	let result = baseForReplace;
	for (let i = matched.length - 1; i >= 0; i--) {
		const m = matched[i];
		result = result.substring(0, m.matchIndex) + m.newText + result.substring(m.matchIndex + m.matchLength);
	}

	if (result === baseForReplace) throw new FileError('invalid', 'No changes made. The replacement produced identical content.', path);

	return { baseContent: normalizedContent, newContent: result };
}

/** 简化的 display diff（带行号 + 上下文）。spice 不引 jsdiff 第三方依赖，自写足够。 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 3,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');
	const max = Math.max(oldLines.length, newLines.length);
	const w = String(max).length;
	const out: string[] = [];
	let oi = 1, ni = 1, firstChanged: number | undefined;
	while (oi <= oldLines.length || ni <= newLines.length) {
		const o = oldLines[oi - 1] ?? '';
		const n = newLines[ni - 1] ?? '';
		if (oi <= oldLines.length && ni <= newLines.length && o === n) {
			out.push(` ${String(oi).padStart(w)} ${o}`);
			oi++; ni++;
		} else {
			if (firstChanged === undefined) firstChanged = ni;
			if (oi <= oldLines.length) {
				out.push(`-${String(oi).padStart(w)} ${o}`);
				oi++;
			}
			if (ni <= newLines.length) {
				out.push(`+${String(ni).padStart(w)} ${n}`);
				ni++;
			}
		}
	}
	return { diff: out.join('\n'), firstChangedLine: firstChanged };
}
