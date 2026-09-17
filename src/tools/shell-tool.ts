// src/tools/shell-tool.ts —— Shell 工具（Task 7；spec §3.3 表第七行）。
// 输入 `{command, timeout?}`（秒，默认 30，见 DEFAULT_TIMEOUT_SECONDS）→ 经 `ExecutionEnv.exec` 走 §3.2 的接线；
// 输出只能从 `onUpdate` 累积（`ShellExecResult` 只带 exitCode + 截断元数据），按上游 `applyShellOutputUpdate` 组装视图。
// description 如实声明 wasi-sh busybox 的架构性缺失（无 fork：后台任务/需 fork 的子 shell/进程替换会响亮报错）
// 以及 capture.spill 不支持（spec §6：超限截断即弃，不落盘）——模型据此选命令，而不是撞上才学。
import { type Static, Type } from 'typebox';
import {
	applyShellOutputUpdate, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES,
	type AgentTool, type ExecutionEnv, type ShellOutputTruncation, type ShellOutputView,
} from '@earendil-works/pi-agent-core';
import { contextFor, textResult, throwIfAborted } from './fs-ops';

/** 默认超时（秒）：30 秒足够一次编码 agent 的常规命令，又不至于把卡死的命令拖到用户失耐心 */
const DEFAULT_TIMEOUT_SECONDS = 30;

const shellSchema = Type.Object({
	command: Type.String({ description: 'Shell command to run (busybox ash + coreutils).' }),
	timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}).` })),
});

export type ShellToolInput = Static<typeof shellSchema>;

export interface ShellToolDetails {
	exitCode: number;
	truncation: ShellOutputTruncation;
}

export interface ShellToolOptions {
	/** exec 与 fs 都从 ExecutionEnv 取（Shell 工具是唯一需要 exec 面的工具，其余六个只要 fs） */
	env: ExecutionEnv;
}

export function createShellTool(opts: ShellToolOptions): AgentTool<typeof shellSchema, ShellToolDetails> {
	const { env } = opts;
	return {
		name: 'Shell',
		label: 'Shell',
		description: `Run a shell command in the workspace. The shell is busybox ash + coreutils (a single busybox process): background jobs (&), sub shells that require a fork, and process substitution are not supported and fail loudly instead of silently. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB whichever is hit first, and capture.spill is not supported (truncated output is discarded, not spilled to a file).`,
		parameters: shellSchema,
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			let view: ShellOutputView | undefined;
			const result = await env.exec(input.command, {
				timeout: input.timeout ?? DEFAULT_TIMEOUT_SECONDS,
				capture: { limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES } },
				onUpdate: (update) => { view = applyShellOutputUpdate(view, update); },
			}, contextFor(signal));
			if (!result.ok) throw result.error;
			const output = view?.text ?? '';
			const parts = [output === '' ? '(no output)' : output];
			if (result.value.exitCode !== 0) parts.push(`[exit code: ${result.value.exitCode}]`);
			return textResult(parts.join('\n'), { exitCode: result.value.exitCode, truncation: result.value.truncation });
		},
	};
}
