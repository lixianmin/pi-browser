// src/tools/bash-tool.ts —— Bash 工具（P2d Task 17）。
// 契约面 1:1 于 pi-coding-agent@1.0.0 dist/core/tools/bash.{js,d.ts}：schema 描述 / description /
// promptSnippet / BashOperations / BashToolDetails / 两导出形状。
// 偏离（写进 ledger）：
//   ① `BashOperations.exec` 的 `onData` 用 `Uint8Array`（D1：上游 Buffer）、`env` 用 `Record<string,string>`。
//   ② `spill` 是本仓扩展：上游 `OutputAccumulator` 自己用 node:fs 开临时文件，浏览器要注入 seam。
//   ③ 不声明 `shellPath` / `exposeSessionEnvironment` / `spawnHook`（D7）；`promptGuidelines` 因此为 undefined
//      （上游 `exposeSessionEnvironment === false` 的分支）。
//   ④ 保留 P1 的净化（`sanitizeBinaryOutput` + 去 `\r`）与截断提示形状（Task 6 ruling）；错误保留
//      `ExecutionError` 码（spec §3.3），不学上游转成 plain Error。
// 平台偏差（P6 README）：busybox 无 fork（后台任务/需 fork 的子 shell/进程替换响亮失败）；不暴露 `PI_*`。

import { type Static, Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '../extensions/tool';
import { OutputAccumulator, type OutputAccumulatorSpill } from '../shell/output-accumulator';
import { sanitizeBinaryOutput } from '../shell/sanitize';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from './truncate';
import { throwIfAborted } from './fs-ops';

const bashSchema = Type.Object({
	command: Type.String({ description: 'Shell command to execute' }),
	timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
});

export const bashToolSystemPromptContribution = {
	snippet: 'Execute bash commands (ls, grep, find, etc.)',
	guidelines: ['You can inspect PI_* environment variables for current model and session details.'],
} as const;

const bashToolDescription = `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`;

export type BashToolInput = Static<typeof bashSchema>;

/** 上游 1.0.0 `BashToolDetails`：exit code 只进 content 文本，不在 details 里 */
export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** 可插拔的命令执行操作（对齐上游 `BashOperations`；`Buffer` → `Uint8Array`，D1）。 */
export interface BashOperations {
	/**
	 * 执行命令并流式交付输出。返回退出码；`null` 视为失败（工具会抛错）。
	 */
	exec(
		command: string,
		cwd: string,
		options: {
			onData(data: Uint8Array): void;
			signal?: AbortSignal;
			timeout?: number;
			env?: Record<string, string>;
		},
	): Promise<{ exitCode: number | null }>;
}

export interface BashToolOptions {
	/** 命令执行操作。浏览器没有默认 shell，缺省即抛（D5） */
	operations?: BashOperations;
	/** 本仓扩展：`OutputAccumulator` 的临时文件 seam；缺省则不落盘、`fullOutputPath` 留空 */
	spill?: OutputAccumulatorSpill;
	/** 每条命令前拼一段前缀（例如 shell 初始化），对齐上游 `commandPrefix` */
	commandPrefix?: string;
}

const ENCODER = new TextEncoder();

function requireOperations(options: BashToolOptions | undefined): BashOperations {
	const operations = options?.operations;
	if (operations === undefined) {
		throw new Error('bash tool: 浏览器没有默认 shell，请在 options.operations 注入 BashOperations（D5）');
	}
	return operations;
}

async function executeBash(
	cwd: string,
	input: BashToolInput,
	signal: AbortSignal | undefined,
	options: BashToolOptions,
): Promise<AgentToolResult<BashToolDetails | undefined>> {
	throwIfAborted(signal);
	const operations = requireOperations(options);
	const command = options.commandPrefix === undefined ? input.command : `${options.commandPrefix}\n${input.command}`;
	const accumulator = new OutputAccumulator({ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES, tempFilePrefix: 'pi-bash' }, options.spill);
	// 上游 `handleData` 是 raw append；本仓保留 P1 的净化（P1 Task 6 ruling）：流式解码 → 净化 → 去 CR → 喂字节
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	const sanitized = (text: string): Uint8Array => ENCODER.encode(sanitizeBinaryOutput(text).replace(/\r/g, ''));
	const result = await operations.exec(command, cwd, {
		onData: (data) => accumulator.append(sanitized(decoder.decode(data, { stream: true }))),
		signal,
		timeout: input.timeout,
	});
	accumulator.append(sanitized(decoder.decode()));
	accumulator.finish();
	const snapshot = accumulator.snapshot({ persistIfTruncated: true });
	await accumulator.closeTempFile();
	const truncated = snapshot.truncation.truncated;
	// 只在真截断时给 fullOutputPath：提示行只在截断时出现，否则调用方拿到一个模型无从发现的文件
	const fullOutputPath = truncated ? snapshot.fullOutputPath : undefined;
	const parts = [snapshot.content === '' ? '(no output)' : snapshot.content];
	if (truncated) {
		parts.push(truncationNotice(snapshot.truncation, accumulator.getLastLineBytes(), fullOutputPath));
	}
	const exitCode = result.exitCode;
	if (exitCode === null) {
		throw new Error(`${parts.join('\n')}\n\nCommand terminated without an exit code`);
	}
	const text = exitCode === 0 ? parts.join('\n') : `${parts.join('\n')}\n\nCommand exited with code ${exitCode}`;
	return {
		content: [{ type: 'text', text }],
		details: {
			...(truncated ? { truncation: snapshot.truncation } : {}),
			...(fullOutputPath === undefined ? {} : { fullOutputPath }),
		},
		...(exitCode === 0 ? {} : { isError: true }),
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

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	requireOperations(options);
	return {
		name: 'bash',
		label: 'bash',
		description: bashToolDescription,
		promptSnippet: bashToolSystemPromptContribution.snippet,
		parameters: bashSchema,
		execute: (toolCallId, input, signal, _onUpdate, ctx) => executeBash(ctx?.cwd || cwd, input, signal, options ?? {}),
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	requireOperations(options);
	return {
		name: 'bash',
		label: 'bash',
		description: bashToolDescription,
		parameters: bashSchema,
		execute: (toolCallId, input, signal, _onUpdate) => executeBash(cwd, input, signal, options ?? {}),
	};
}
