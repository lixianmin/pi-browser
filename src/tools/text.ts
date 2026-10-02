// src/tools/text.ts —— 文本解码辅助（Task 10 / P2a-3）。
// 转写源：pi-coding-agent@1.0.0 dist/utils/text.js（逐字；上游只导出这两个）。
// `splitBom` 曾经在 edit-diff.ts 里，P2a 按「edit-diff 导出面与上游逐字对齐」把它移到这里
// （上游 edit-diff.js 是从 utils/text.js 取它的，本仓对齐这个落点）。

/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content };
}
