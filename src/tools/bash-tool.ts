// src/tools/bash-tool.ts —— Bash 工具（Task 7；spec §3.3 表第七行；上游同名对齐）。
// 输入 `{command, timeout?}`（秒，默认 30，见 DEFAULT_TIMEOUT_SECONDS）→ 经 `ExecutionEnv.exec` 走 §3.2 的接线。
// 1.0.0 的 exec 只交付**原始解码分片**（`ShellExecResult` 只带 exitCode + spillPath）：净化与截断由本工具自己做——
// `onOutput` 里净化后喂进自己的 `OutputAccumulator`；超限时 env 已把全量 spill 成文件，details 给出 `fullOutputPath`。
// description 如实声明 wasi-sh busybox 的架构性缺失（无 fork：后台任务/需 fork 的子 shell/进程替换会响亮报错）。
import { type Static, Type } from 'typebox';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ExecutionEnv } from '../env/types';
import { OutputAccumulator } from '../shell/output-accumulator';
import { sanitizeBinaryOutput } from '../shell/sanitize';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from './truncate';
import { contextFor, textResult, throwIfAborted } from './fs-ops';

/** 默认超时（秒）：30 秒足够一次编码 agent 的常规命令，又不至于把卡死的命令拖到用户失耐心 */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** 每次 exec 复用同一个编码器（`sanitize` 后的文本要按字节喂给 accumulator） */
const ENCODER = new TextEncoder();

const bashSchema = Type.Object({
	command: Type.String({ description: 'Bash command to run (busybox ash + coreutils).' }),
	timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}).` })),
});

export type BashToolInput = Static<typeof bashSchema>;

/** 上游 1.0.0 `BashToolDetails` 逐字对齐：exit code 只进 content 文本，不在 details 里 */
export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface BashToolOptions {
	/** exec 与 fs 都从 ExecutionEnv 取（Bash 工具是唯一需要 exec 面的工具，其余六个只要 fs） */
	env: ExecutionEnv;
}

export function createBashTool(opts: BashToolOptions): AgentTool<typeof bashSchema, BashToolDetails> {
	const { env } = opts;
	return {
		name: 'bash',
		label: 'bash',
		description: `Run a shell command in the workspace. The shell is busybox ash + coreutils (a single busybox process): background jobs (&), sub shells that require a fork, and process substitution are not supported and fail loudly instead of silently. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); when truncated, the complete output is saved to a temp file. Timeouts are enforced by the browser worker backend only: on a single-threaded host the timeout value is ignored.`,
		parameters: bashSchema,
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			const accumulator = new OutputAccumulator({ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const result = await env.exec(input.command, {
				timeout: input.timeout ?? DEFAULT_TIMEOUT_SECONDS,
				// 阈值与展示上限同值：跨过它就同时（a）截断展示（b）让 env 把全量 spill 到临时文件
				spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES },
				onOutput: (text) => accumulator.append(ENCODER.encode(sanitizeBinaryOutput(text).replace(/\r/g, ''))),
			}, contextFor(signal));
			if (!result.ok) throw result.error;
			accumulator.finish();
			const snapshot = accumulator.snapshot();
			const truncated = snapshot.truncation.truncated;
			// 只在**真截断**时给 fullOutputPath：env 的 spill 按**原始**字节计数、工具的截断按**净化后**字节，
			// 所以「env 落盘」⊇「工具截断」（净化只减字节）——不 gate 就会把一个模型无从发现
			// （提示行只在截断时出现）的文件塞进 details。
			const fullOutputPath = truncated ? result.value.spillPath : undefined;
			const parts = [snapshot.content === '' ? '(no output)' : snapshot.content];
			if (truncated) {
				parts.push(truncationNotice(snapshot.truncation, accumulator.getLastLineBytes(), fullOutputPath));
			}
			if (result.value.exitCode !== 0) parts.push(`[exit code: ${result.value.exitCode}]`);
			return textResult(parts.join('\n'), {
				...(truncated ? { truncation: snapshot.truncation } : {}),
				...(fullOutputPath === undefined ? {} : { fullOutputPath }),
			});
		},
	};
}

/** 截断提示（形状取自上游 1.0.0 `formatOutput`）：模型靠它知道输出不完整、去哪读全文 */
function truncationNotice(truncation: TruncationResult, lastLineBytes: number, fullOutputPath: string | undefined): string {
	const where = fullOutputPath === undefined ? '' : ` Full output: ${fullOutputPath}`;
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	if (truncation.lastLinePartial) {
		return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(lastLineBytes)}).${where}]`;
	}
	if (truncation.truncatedBy === 'lines') {
		return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${where}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${where}]`;
}
