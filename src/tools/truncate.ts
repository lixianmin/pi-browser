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

/** 字符串 UTF-8 字节长度（跨端：浏览器无 Buffer）。名字对齐上游 `utf8ByteLength`（pi-durable@1.0.0 `dist/truncate.d.ts`、pi-agent-core@0.99.1 `harness/utils/truncate.js:15`）。 */
export function utf8ByteLength(content: string): number {
	return _encoder.encode(content).length;
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
	const totalBytes = utf8ByteLength(content);
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

	const firstLineBytes = utf8ByteLength(lines[0]);
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
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0);   // +1 for newline
		if (outBytes + lineBytes > maxBytes) { truncatedBy = 'bytes'; break; }
		out.push(line);
		outBytes += lineBytes;
	}
	if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = 'lines';

	const content2 = out.join('\n');
	return {
		content: content2, truncated: true, truncatedBy,
		totalLines, totalBytes,
		outputLines: out.length, outputBytes: utf8ByteLength(content2),
		lastLinePartial: false, firstLineExceedsLimit: false,
		maxLines, maxBytes,
	};
}

/**
 * 从尾部截断（保留后 N 行/N 字节）。适合 shell 输出——想看的是结尾（报错、最终结果）。
 * 与上游 `pi-agent-core@0.99.1 harness/utils/truncate.js:178` 逐字对齐（含「单行超字节上限时
 * 从尾部取部分行」的分支）。这是唯一会产出 `lastLinePartial = true` 的路径。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = utf8ByteLength(content);
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

	// 从末尾往前收行；行数超限或字节超限先到先触发
	const out: string[] = [];
	let outBytes = 0;
	let truncatedBy: 'lines' | 'bytes' = 'lines';
	let lastLinePartial = false;
	for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (out.length > 0 ? 1 : 0);   // +1 for newline
		if (outBytes + lineBytes > maxBytes) {
			truncatedBy = 'bytes';
			// 一行还没收进来且这行本身就超上限：从尾部取部分行（唯一允许出现半行的地方）
			if (out.length === 0) {
				const partial = truncateStringToBytesFromEnd(line, maxBytes);
				out.unshift(partial);
				outBytes = utf8ByteLength(partial);
				lastLinePartial = true;
			}
			break;
		}
		out.unshift(line);
		outBytes += lineBytes;
	}
	if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = 'lines';

	const outContent = out.join('\n');
	return {
		content: outContent, truncated: true, truncatedBy,
		totalLines, totalBytes,
		outputLines: out.length, outputBytes: utf8ByteLength(outContent),
		lastLinePartial, firstLineExceedsLimit: false,
		maxLines, maxBytes,
	};
}

/** 从字符串尾部按 UTF-8 字节取，只在字符边界切断。
 *
 * **本仓自写**（plan Task 1 Step 3 指定手写，不是上游转写）：从 UTF-16 尾部按码点回扫，输出恒为合法 UTF-8
 * （未配对的代理项换成 U+FFFD），所以 `outputBytes === utf8ByteLength(content)` 恒成立。
 * 与上游 1.0.0 的 Buffer 切片版（`truncate.js` 里按 `buf.length - maxBytes` 切再跳过续接字节）在切点
 * 恰好落在多字节字符边界时最多差 3 字节，且上游那版会在头部留一个替换字符。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	if (maxBytes <= 0) return '';
	let outputBytes = 0;
	let start = str.length;
	let needsReplacement = false;
	for (let i = str.length; i > 0;) {
		let characterStart = i - 1;
		const code = str.charCodeAt(characterStart);
		let characterBytes: number;
		let unpairedSurrogate = false;
		if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
			const previous = str.charCodeAt(characterStart - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) {
				characterStart--;
				characterBytes = 4;
			} else {
				characterBytes = 3;
				unpairedSurrogate = true;
			}
		} else if (code >= 0xd800 && code <= 0xdfff) {
			characterBytes = 3;
			unpairedSurrogate = true;
		} else {
			characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
		}
		if (outputBytes + characterBytes > maxBytes) break;
		outputBytes += characterBytes;
		start = characterStart;
		needsReplacement ||= unpairedSurrogate;
		i = characterStart;
	}
	const output = str.slice(start);
	return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

/** 孤立代理项换 U+FFFD（上游同名私有函数的逐字转写）。 */
function replaceUnpairedSurrogates(content: string): string {
	let output = '';
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (i + 1 < content.length) {
				const next = content.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					output += content[i] + content[i + 1];
					i++;
					continue;
				}
			}
			output += '\uFFFD';
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			output += '\uFFFD';
		} else {
			output += content[i];
		}
	}
	return output;
}

/** 单行截断（grep 输出专用），超长行尾加 "... [truncated]"。 */
export function truncateLine(line: string, maxChars: number = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

export interface MiddleTruncationResult {
	/** 头 + `…N chars truncated…` + 尾 */
	content: string;
	truncated: boolean;
	/** 被省略的字符数（按 Unicode 码点计，不是字节数） */
	removedChars: number;
	totalBytes: number;
	totalLines: number;
}

/** 与上游 `Buffer.toString('utf-8')` 等价：`ignoreBOM: true` 表示不吞掉开头的 BOM（默认会吞）。 */
const _decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * 保留 `content` 的头与尾（各占 `maxBytes` 的一半），中间换成 `…N chars truncated…` 标记。
 * 只在字符边界切。转写源：pi-coding-agent@1.0.0 dist/core/tools/truncate.js:219-243
 * （唯一偏离：`Buffer` → `TextEncoder` / `TextDecoder`，见 spec D1）。
 */
export function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult {
	const buf = _encoder.encode(content);
	const totalLines = splitLinesForCounting(content).length;
	if (buf.length <= maxBytes) {
		return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
	}
	// 续接字节（10xxxxxx）不是字符起点
	const isBoundary = (index: number): boolean => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
	let headEnd = Math.floor(maxBytes / 2);
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
	let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
	const head = _decoder.decode(buf.subarray(0, headEnd));
	const tail = _decoder.decode(buf.subarray(tailStart));
	const removedChars = Array.from(_decoder.decode(buf.subarray(headEnd, tailStart))).length;
	return {
		content: `${head}…${removedChars} chars truncated…${tail}`,
		truncated: true,
		removedChars,
		totalBytes: buf.length,
		totalLines,
	};
}
