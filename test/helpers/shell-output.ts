// Task 6 的测试助手。1.0.0 的 exec 只交付**原始解码分片**（`ShellExecResult` 只有 exitCode + spillPath），
// 展示文本由调用方用 `OutputAccumulator` 自己累积——所有 shell 测试共用这一条路径（与 `createBashTool` 同法）。
import type { ExecutionError, Result } from '@earendil-works/pi-durable/env';
import { BACKGROUND_CONTEXT, type Context } from '../../src/env/context';
import type { ExecutionEnv, ShellExecOptions, ShellExecResult } from '../../src/env/types';
import { OutputAccumulator } from '../../src/shell/output-accumulator';
import type { TruncationResult } from '../../src/tools/truncate';

const ENCODER = new TextEncoder();

export interface ExecWithOutputResult {
	result: Result<ShellExecResult, ExecutionError>;
	/** 累积后的展示文本（默认尾保留 2000 行 / 50KB） */
	output: string;
	truncation: TruncationResult;
}

export async function execWithOutput(
	env: ExecutionEnv,
	command: string,
	options?: ShellExecOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ExecWithOutputResult> {
	const accumulator = new OutputAccumulator();
	const result = await env.exec(command, {
		...options,
		onOutput: (text) => {
			options?.onOutput?.(text, context);
			accumulator.append(ENCODER.encode(text));
		},
	}, context);
	accumulator.finish();
	const snapshot = accumulator.snapshot();
	return { result, output: snapshot.content, truncation: snapshot.truncation };
}
