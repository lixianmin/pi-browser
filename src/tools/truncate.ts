// src/tools/truncate.ts —— 工具输出截断（Task 5）。
// 平移源：spice `packages/harness/src/agent/truncate.ts`（函数体逐字；该文件无 registry/fs 依赖，纯函数，
// 所以只改文件头与 import 注释，代码未动）。上游再往上是 pi-coding-agent `core/tools/truncate.ts`：
// 双阈值（行数 + 字节），先到先触发；从不截断单行中间（除首行超限与尾行边界）。
// Read/Grep 等工具的输出必须带截断，否则会撑爆 LLM 上下文。

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;   // 50KB
export const GREP_MAX_LINE_LENGTH = 500;       // grep 单行截断（防止单行 base64 等撑爆）

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: 'lines' | 'bytes' | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split('\n');
	if (content.endsWith('\n')) lines.pop();
	return lines;
}

const _encoder = new TextEncoder();   // 浏览器/Node 均有 TextEncoder（Buffer 仅 Node，Web 无 —— 浏览器兼容必须走 TextEncoder）

/** 字符串 utf-8 字节长度（跨端：浏览器无 Buffer） */
function byteLength(s: string, _encoding?: string): number {
	return _encoder.encode(s).length;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 从头部截断（保留前 N 行/N 字节）。适合文件 Read 场景。 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = byteLength(content, 'utf-8');
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content, truncated: false, truncatedBy: null,
			totalLines, totalBytes,
			outputLines: totalLines, outputBytes: totalBytes,
			lastLinePartial: false, firstLineExceedsLimit: false,
			maxLines, maxBytes,
		};
	}

	const firstLineBytes = byteLength(lines[0], 'utf-8');
	if (firstLineBytes > maxBytes) {
		return {
			content: '', truncated: true, truncatedBy: 'bytes',
			totalLines, totalBytes,
			outputLines: 0, outputBytes: 0,
			lastLinePartial: false, firstLineExceedsLimit: true,
			maxLines, maxBytes,
		};
	}

	const out: string[] = [];
	let outBytes = 0;
	let truncatedBy: 'lines' | 'bytes' = 'lines';
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = byteLength(line, 'utf-8') + (i > 0 ? 1 : 0);   // +1 for newline
		if (outBytes + lineBytes > maxBytes) { truncatedBy = 'bytes'; break; }
		out.push(line);
		outBytes += lineBytes;
	}
	if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = 'lines';

	const content2 = out.join('\n');
	return {
		content: content2, truncated: true, truncatedBy,
		totalLines, totalBytes,
		outputLines: out.length, outputBytes: byteLength(content2, 'utf-8'),
		lastLinePartial: false, firstLineExceedsLimit: false,
		maxLines, maxBytes,
	};
}

/** 单行截断（grep 输出专用），超长行尾加 "... [truncated]"。 */
export function truncateLine(line: string, maxChars: number = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
