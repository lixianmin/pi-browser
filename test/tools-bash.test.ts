// @vitest-environment node
// Task 6/7：Bash 工具契约测试（spec §3.3 表第七行 + §3.2 exec 映射）。
// 覆盖：输入 {command, timeout?} 默认 30s → 经 ExecutionEnv.exec；输出经 onOutput 累积进工具自己的
// OutputAccumulator（1.0.0 的 ShellExecResult 只带 exitCode + spillPath）；超限走 spill + 截断提示；
// shell:false 的占位错误；abort；description 如实声明 busybox 的不支持项。
// 硬杀/超时路径不在本测试范围（spec §4.2：node 环境走 inline，timeout 不生效，以 spike 真浏览器实测 + 评审为据）。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { ok, type ExecutionError, type Result } from '@earendil-works/pi-durable/env';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem, ExecutionEnv, ShellExecOptions, ShellExecResult } from '../src/env/types';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { createBashTool } from '../src/tools/bash-tool';

const CTX = BACKGROUND_CONTEXT;

const textOf = (r: AgentToolResult<unknown>): string =>
	r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

/** 真 busybox（node 下走 inline 路径）；显式双挂载，避免默认 '/'-IDB 在 node 下要 fake-indexeddb */
const isolatedEnv = (): ExecutionEnv => createBrowserExecutionEnv({
	mounts: [
		{ prefix: '/', fs: createMemoryFileSystem('/') },
		{ prefix: '/tmp', fs: createMemoryFileSystem('/tmp') },
	],
});

const busyboxEnv = (root: BrowserFileSystem = createMemoryFileSystem('/')): ExecutionEnv =>
	createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: root }] });

/** 假 env：只记录 exec 收到什么、按 1.0.0 语义喂一次 onOutput（断言选项映射，不跑真 shell）。
 *  `emit` 可换成任意载荷（用来造「env 落盘但工具不截断」这类字节基准分叉）。 */
function recordingEnv(seen: ShellExecOptions[], reply: { emit?: string; spillPath?: string } = {}): ExecutionEnv {
	return {
		...createMemoryFileSystem(),
		exec: async (_command: string, options: ShellExecOptions | undefined): Promise<Result<ShellExecResult, ExecutionError>> => {
			seen.push(options ?? {} as ShellExecOptions);
			options?.onOutput?.(reply.emit ?? 'hi\n', CTX);
			return ok<ShellExecResult, ExecutionError>({ exitCode: 0, ...(reply.spillPath === undefined ? {} : { spillPath: reply.spillPath }) });
		},
		cleanup: async () => {},
	};
}

describe('bash tool', () => {
	it('经 ExecutionEnv.exec 跑 busybox，stdout 累积成 content', async () => {
		const out = textOf(await createBashTool({ env: busyboxEnv() }).execute('id', { command: 'echo hello' }));
		expect(out).toBe('hello\n');
	});

	it('退出码非 0 → content 附 exit code（details 里没有 exitCode，上游 1.0.0 同形）', async () => {
		const r = await createBashTool({ env: busyboxEnv() }).execute('id', { command: 'exit 3' });
		expect(textOf(r)).toBe('(no output)\n[exit code: 3]');
		expect(r.details.truncation).toBeUndefined();
		expect(r.details.fullOutputPath).toBeUndefined();
	});

	it('无输出 → (no output)', async () => {
		expect(textOf(await createBashTool({ env: busyboxEnv() }).execute('id', { command: 'true' }))).toBe('(no output)');
	});

	it('命令写文件端到端落进挂载的 fs（inline 路径 run 边界同步）', async () => {
		const fs = createMemoryFileSystem('/');
		await createBashTool({ env: busyboxEnv(fs) }).execute('id', { command: 'echo written > out.txt' });
		const read = await fs.readTextFile('/out.txt', CTX);
		expect(read.ok && read.value).toBe('written\n');
	});

	it('timeout 默认 30（秒），可按输入覆盖', async () => {
		const seen: ShellExecOptions[] = [];
		const tool = createBashTool({ env: recordingEnv(seen) });
		expect(textOf(await tool.execute('id', { command: 'echo hi' }))).toBe('hi\n');
		await tool.execute('id', { command: 'echo hi', timeout: 5 });
		expect(seen[0].timeout).toBe(30);
		expect(seen[1].timeout).toBe(5);
	});

	it('spill 阈值与展示上限同值，并订阅 onOutput（截断与落盘同步发生）', async () => {
		const seen: ShellExecOptions[] = [];
		await createBashTool({ env: recordingEnv(seen) }).execute('id', { command: 'echo hi' });
		expect(seen[0].spill?.afterBytes).toBe(50 * 1024);
		expect(seen[0].spill?.afterLines).toBe(2000);
		expect(seen[0].onOutput).toBeTypeOf('function');
	});

	it('超限输出：截断展示 + 提示行 + details 带 fullOutputPath（env 已把全量 spill 到 /tmp）', async () => {
		const env = isolatedEnv();
		const r = await createBashTool({ env }).execute('id', { command: 'seq 1 3000' });
		const text = textOf(r);

		expect(text).toContain('[Showing lines');
		expect(text).toContain('Full output: /tmp/');
		expect(r.details.truncation?.truncated).toBe(true);
		const path = r.details.fullOutputPath;
		expect(path?.startsWith('/tmp/')).toBe(true);
		// 全量读得回（同一 env 的 /tmp 挂载）
		const read = await env.readTextFile(path!, CTX);
		expect(read.ok && read.value.trimEnd().split('\n')).toHaveLength(3000);
	});

	// 回归：截断/落盘曾经被算两遍、两个字节基准（env 数原始字节，工具数净化后的字节）。净化只减字节，
	// 所以「env 落盘」⊇「工具截断」：>50KB 全是控制字符时 env 建了 spill 文件，而工具根本没截断 ——
	// 那个文件模型无从发现（提示行只在截断时出现），却曾经被塞进 details。
	it('env 落盘但工具未截断：details 不带 fullOutputPath（不把模型看不到的文件塞给调用方）', async () => {
		const seen: ShellExecOptions[] = [];
		const env = recordingEnv(seen, { emit: '\r'.repeat(60_000), spillPath: '/tmp/pi-shell-fake.log' });
		const r = await createBashTool({ env }).execute('id', { command: 'echo x' });
		expect(textOf(r)).toBe('(no output)');
		expect(r.details.truncation).toBeUndefined();
		expect(r.details.fullOutputPath).toBeUndefined();
	});

	// Task 6 的行为变更（净化 + 去 \r）曾经零覆盖：拿掉 sanitize/去 \r，384 条测试全绿。
	it('净化：控制字符与 \\r 不进展示文本', async () => {
		const r = await createBashTool({ env: busyboxEnv() }).execute('id', { command: `printf 'a\\rb\\001c\\n'` });
		expect(textOf(r)).toBe('abc\n');
	});

	it('shell:false 的占位 env → shell_unavailable（ExecutionError 原样抛出）', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }], shell: false });
		await expect(createBashTool({ env }).execute('id', { command: 'echo hi' }))
			.rejects.toMatchObject({ code: 'shell_unavailable' });
	});

	it('调用前已 abort → aborted（ExecutionError 由 exec 给）', async () => {
		await expect(createBashTool({ env: busyboxEnv() }).execute('id', { command: 'echo never' }, AbortSignal.abort()))
			.rejects.toMatchObject({ code: 'aborted' });
	});

	it('description 如实声明 busybox 语义与不支持项', () => {
		const { description } = createBashTool({ env: busyboxEnv() });
		expect(description).toContain('busybox ash');
		expect(description).toContain('background jobs (&)');
		expect(description).toContain('sub shells');
		expect(description).toContain('process substitution');
		expect(description).toContain('fail loudly');
		expect(description).toContain('saved to a temp file');
		expect(description).toContain('browser worker backend only');
	});
});
