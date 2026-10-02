// @vitest-environment node
// Task 17（P2d）：Bash 工具契约测试。
// 1.0.0 形状：`createBashTool(cwd, { operations })` + `BashOperations.exec(command, cwd, { onData, … })`；
// 输出经 onData 累积进工具自己的 OutputAccumulator（spill 由本仓扩展 seam 注入）；
// exitCode ≠ 0 → `Command exited with code N` + isError；净化/去 \r 是 P1 保留行为。
// 硬杀/超时路径不在本测试范围（spec §4.5：node 环境走 inline，以 spike 真浏览器实测 + 评审为据）。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem, ExecutionEnv } from '../src/env/types';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { createMountTable } from '../src/env/mount';
import { createMountSpill } from '../src/shell/output-accumulator';
import { createBashTool, createBashToolDefinition, bashToolSystemPromptContribution, type BashOperations } from '../src/tools/bash-tool';
import * as upstreamBash from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js';
import { bashOps } from './helpers/tool-operations';

const CTX = BACKGROUND_CONTEXT;
const ENCODER = new TextEncoder();

const textOf = (r: AgentToolResult<unknown>): string =>
	r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

/** 真 busybox（node 下走 inline 路径）；显式挂载避免默认 '/'-IDB 要 fake-indexeddb。 */
const busyboxEnv = (root: BrowserFileSystem = createMemoryFileSystem('/')): ExecutionEnv =>
	createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: root }] });

/** 双挂载 + 工具的 spill seam（上游 OutputAccumulator 自己开临时文件；本仓注入）。 */
const isolated = (): { env: ExecutionEnv; spill: ReturnType<typeof createMountSpill> } => {
	const mounts = [
		{ prefix: '/', fs: createMemoryFileSystem('/') },
		{ prefix: '/tmp', fs: createMemoryFileSystem('/tmp') },
	];
	return { env: createBrowserExecutionEnv({ mounts }), spill: createMountSpill(createMountTable(mounts), 'pi-bash') };
};

interface SeenExec {
	command: string;
	timeout?: number;
	env?: Record<string, string>;
}

/** 假 operations：只记录 exec 收到什么、按上游语义喂一次 onData（断言选项映射与拼装）。 */
function recordingOps(seen: SeenExec[], reply: { emit?: string; exitCode?: number | null } = {}): BashOperations {
	return {
		exec: async (command, _cwd, options) => {
			seen.push({ command, timeout: options.timeout, env: options.env });
			options.onData(ENCODER.encode(reply.emit ?? 'hi\n'));
			return { exitCode: reply.exitCode === undefined ? 0 : reply.exitCode };
		},
	};
}

describe('bash tool', () => {
	it('经 BashOperations.exec 跑 busybox，onData 累积成 content', async () => {
		const out = textOf(await createBashTool('/', { operations: bashOps(busyboxEnv()) }).execute('id', { command: 'echo hello' }));
		expect(out).toBe('hello\n');
	});

	it('退出码非 0 → content 附 `Command exited with code N`，isError=true（details 无 exitCode）', async () => {
		const r = await createBashTool('/', { operations: bashOps(busyboxEnv()) }).execute('id', { command: 'exit 3' });
		expect(textOf(r)).toBe('(no output)\n\nCommand exited with code 3');
		expect(r.isError).toBe(true);
		expect(r.details?.truncation).toBeUndefined();
		expect(r.details?.fullOutputPath).toBeUndefined();
	});

	it('无输出 → (no output)', async () => {
		expect(textOf(await createBashTool('/', { operations: bashOps(busyboxEnv()) }).execute('id', { command: 'true' }))).toBe('(no output)');
	});

	it('命令写文件端到端落进挂载的 fs（inline 路径 run 边界同步）', async () => {
		const fs = createMemoryFileSystem('/');
		await createBashTool('/', { operations: bashOps(busyboxEnv(fs)) }).execute('id', { command: 'echo written > out.txt' });
		const read = await fs.readTextFile('/out.txt', CTX);
		expect(read.ok && read.value).toBe('written\n');
	});

	it('timeout 无默认值（上游语义），按输入透传', async () => {
		const seen: SeenExec[] = [];
		const tool = createBashTool('/', { operations: recordingOps(seen) });
		expect(textOf(await tool.execute('id', { command: 'echo hi' }))).toBe('hi\n');
		await tool.execute('id', { command: 'echo hi', timeout: 5 });
		expect(seen[0].timeout).toBeUndefined();
		expect(seen[1].timeout).toBe(5);
	});

	it('commandPrefix 拼在命令前', async () => {
		const seen: SeenExec[] = [];
		await createBashTool('/', { operations: recordingOps(seen), commandPrefix: 'export A=1' }).execute('id', { command: 'echo hi' });
		expect(seen[0].command).toBe('export A=1\necho hi');
	});

	it('超限输出：截断展示 + 提示行 + details 带 fullOutputPath（工具自己的 spill 落 /tmp）', async () => {
		const { env, spill } = isolated();
		const r = await createBashTool('/', { operations: bashOps(env), spill }).execute('id', { command: 'seq 1 3000' });
		const text = textOf(r);
		expect(text).toContain('[Showing lines');
		expect(text).toContain('Full output: /tmp/pi-bash');
		expect(r.details?.truncation?.truncated).toBe(true);
		const path = r.details?.fullOutputPath;
		expect(path?.startsWith('/tmp/pi-bash')).toBe(true);
		// 全量读得回（同一挂载表）
		const read = await env.readTextFile(path!, CTX);
		expect(read.ok && read.value.trimEnd().split('\n')).toHaveLength(3000);
	});

	it('未接 spill seam：仍报截断，但 details 不带 fullOutputPath', async () => {
		const { env } = isolated();
		const r = await createBashTool('/', { operations: bashOps(env) }).execute('id', { command: 'seq 1 3000' });
		expect(r.details?.truncation?.truncated).toBe(true);
		expect(r.details?.fullOutputPath).toBeUndefined();
	});

	it('净化：控制字符与 \\r 不进展示文本（P1 保留行为）', async () => {
		const r = await createBashTool('/', { operations: bashOps(busyboxEnv()) }).execute('id', { command: `printf 'a\\rb\\001c\\n'` });
		expect(textOf(r)).toBe('abc\n');
	});

	it('shell:false 的占位 env → shell_unavailable（ExecutionError 原样抛出）', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }], shell: false });
		await expect(createBashTool('/', { operations: bashOps(env) }).execute('id', { command: 'echo hi' }))
			.rejects.toMatchObject({ code: 'shell_unavailable' });
	});

	it('调用前已 abort → aborted', async () => {
		await expect(createBashTool('/', { operations: bashOps(busyboxEnv()) }).execute('id', { command: 'echo never' }, AbortSignal.abort()))
			.rejects.toMatchObject({ code: 'aborted' });
	});

	it('exitCode === null → 抛 Command terminated without an exit code', async () => {
		const ops = recordingOps([], { emit: 'partial\n', exitCode: null });
		await expect(createBashTool('/', { operations: ops }).execute('id', { command: 'x' })).rejects.toThrow(/terminated without an exit code/);
	});

	it('静态字段与上游产物逐字相等（P2d 契约）', () => {
		const up = upstreamBash.createBashToolDefinition('/tmp', { exposeSessionEnvironment: false });
		const mine = createBashToolDefinition('/tmp', { operations: bashOps(busyboxEnv()) });
		expect(mine.name).toBe(up.name);
		expect(mine.label).toBe(up.label);
		expect(mine.description).toBe(up.description);
		expect(mine.promptSnippet).toBe(up.promptSnippet);
		// 不暴露 PI_* → 走上游 exposeSessionEnvironment=false 的分支：promptGuidelines 两处都是 undefined
		expect(mine.promptGuidelines).toEqual(up.promptGuidelines);
		expect(JSON.parse(JSON.stringify(mine.parameters))).toEqual(JSON.parse(JSON.stringify(up.parameters)));
		expect(bashToolSystemPromptContribution).toEqual(upstreamBash.bashToolSystemPromptContribution);
	});

	it('operations 缺省 → 构造期响亮报错（D5）', () => {
		expect(() => createBashToolDefinition('/tmp')).toThrow(/operations/);
		expect(() => createBashTool('/tmp')).toThrow(/operations/);
	});
});
