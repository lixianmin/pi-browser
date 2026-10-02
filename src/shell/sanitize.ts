// src/shell/sanitize.ts —— 输出净化（出处：pi-coding-agent@1.0.0 `dist/utils/shell.js:133` 的原文）。
//
// 为什么本地化：上游把 `sanitizeBinaryOutput` 放在 coding-agent 的工具层 utils 里（包入口不导出），
// 而本仓的运行时不再依赖 coding-agent（它只是 devDep）。控制字符会污染展示与提示词，必须留下一份。
/** 删掉单 UTF-16 码元的不可打印控制字符（保留 `\t` `\n` `\r`；`\r` 的清除在调用方按需另做） */
export function sanitizeBinaryOutput(str: string): string {
	// 被删的都是单个 UTF-16 码元，代理对不会被拆开（上游注释原文）
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, '');
}
