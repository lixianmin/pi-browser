// src/tools/write-tool.ts —— Write 工具（Task 5；spec §3.3 表第二行）。
// 平移源：spice `packages/harness/src/agent/tools/WriteTool.ts`（上游 pi-coding-agent `core/tools/write.ts` 简化版）：
// 整文件覆盖写 + 成功文案逐字保留（`Successfully wrote to <path> (N bytes).`，spice e2e 依赖）。
// 偏离（spec §3.3）：① 数据源 registry → fs；② 自动建父目录（BrowserFileSystem.writeFile 的既有语义，
// spice 是靠 Resource.write 自己处理，两侧都自动建目录但实现位置不同）；
// ③ 删 spice 的只读路径白名单（docs/...）——那是 spice 域规则，通用 fs 层不认目录语义（见 path-utils.ts 注释）。
import { type Static, Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types';
import { resolveToCwd } from './path-utils';
import { contextFor, textResult, throwIfAborted, writeText } from './fs-ops';

const writeSchema = Type.Object({
	path: Type.String({ description: 'Path to write to (relative to cwd or absolute). Missing parent directories are created.' }),
	content: Type.String({ description: 'Full file content to write.' }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/** 结果的 details 为空：Write 没有给 UI 的结构化信息 */
export type WriteToolDetails = Record<string, never>;

export interface WriteToolOptions {
	fs: BrowserFileSystem;
	/** 相对路径基准（默认 fs.cwd） */
	cwd?: string;
}

export function createWriteTool(opts: WriteToolOptions): AgentTool<typeof writeSchema, WriteToolDetails> {
	const { fs } = opts;
	const cwd = opts.cwd ?? fs.cwd;
	return {
		name: 'write',
		label: 'write',
		description: 'Write content to a file. Creates the file if it does not exist (creating missing parent directories), overwrites it if it exists. Prefer Edit for partial changes; use Write for new files and complete rewrites.',
		parameters: writeSchema,
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			const absolutePath = resolveToCwd(input.path, cwd);
			await writeText(fs, absolutePath, input.content, contextFor(signal));
			throwIfAborted(signal);
			return textResult(`Successfully wrote to ${input.path} (${input.content.length} bytes).`);
		},
	};
}
