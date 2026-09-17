// @vitest-environment node
// spec §3.2/§4.2：exec 接线 wasi-sh busybox。vitest 是 node env（无 Worker 全局）→ 走 inline 路径；
// worker/硬杀路径的自动化不在 M3 闸门内（spec §4.2：以 spike 真浏览器实测 + 代码评审为据）。
import { describe, it, expect } from 'vitest';
import {
	BACKGROUND_CONTEXT, applyShellOutputUpdate, withAbortSignal,
	type ExecutionEnv, type ExecutionError, type Result,
	type ShellExecOptions, type ShellOutputUpdate, type ShellOutputView,
} from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';

const CTX = BACKGROUND_CONTEXT;
const getOrFail = <T>(r: Result<T, { code: string; message: string }>): T => {
	if (!r.ok) throw new Error(`expected ok: ${r.error.code} ${r.error.message}`);
	return r.value;
};
const newEnv = (root: BrowserFileSystem = createMemoryFileSystem()): ExecutionEnv =>
	createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: root }] });

/** 命令输出只经 onUpdate 交付（ShellExecResult 里只有 exitCode + 截断元数据），这里按上游 applyShellOutputUpdate 累积 */
async function execWithOutput(env: ExecutionEnv, command: string, options?: ShellExecOptions) {
	let view: ShellOutputView | undefined;
	const result = await env.exec(command, { ...options, onUpdate: (u: ShellOutputUpdate) => { view = applyShellOutputUpdate(view, u); } }, CTX);
	return { result, output: view?.text ?? '' };
}

describe('exec：busybox inline 路径', () => {
	it('默认 shell=busybox：echo 返回 ok、退出码 0、stdout 经 onUpdate 交付', async () => {
		const { result, output } = await execWithOutput(newEnv(), 'echo hello');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.exitCode).toBe(0);
		expect(output).toBe('hello\n');
		expect(result.value.truncation.truncated).toBe(false);
	});

	it('退出码透传（exit 7），运行结束无异常', async () => {
		const { result } = await execWithOutput(newEnv(), 'exit 7');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.exitCode).toBe(7);
	});

	it('cwd 存在时命令在 cwd 下跑；不存在 → spawn_error（不抛）', async () => {
		const env = newEnv();
		getOrFail(await env.createDir('/d', { recursive: true }, CTX));
		const { result, output } = await execWithOutput(env, 'pwd', { cwd: '/d' });
		expect(result.ok).toBe(true);
		expect(output).toBe('/d\n');

		const missing = await env.exec('pwd', { cwd: '/nope' }, CTX);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe('spawn_error');
	});

	it('调用前已 abort → aborted（inline 无中断通道，只做调用前检查）', async () => {
		const env = newEnv();
		const aborted = await env.exec('echo never', undefined, withAbortSignal(AbortSignal.abort(), CTX));
		expect(aborted.ok).toBe(false);
		if (!aborted.ok) expect(aborted.error.code).toBe('aborted');
	});

	it('run 边界：宿主写 guest 读到，guest 写落回宿主 fs（含 mkdir 与删除）', async () => {
		const root = createMemoryFileSystem();
		getOrFail(await root.writeFile('/in.txt', 'js-side', CTX));
		const env = newEnv(root);

		const first = await execWithOutput(env, 'cat /in.txt');
		expect(first.output).toBe('js-side');

		const second = await execWithOutput(env, 'mkdir -p /out && echo made > /out/f.txt && rm /in.txt');
		expect(second.result.ok).toBe(true);
		expect(getOrFail(await root.readTextFile('/out/f.txt', CTX))).toBe('made\n');
		expect(getOrFail(await root.exists('/in.txt', CTX))).toBe(false);
	});

	it('capture.limits 生效：尾保留 + 截断元数据（先到先触发）', async () => {
		const { result, output } = await execWithOutput(newEnv(), 'seq 1 10', { capture: { limits: { maxBytes: 1024, maxLines: 3, retain: 'tail' } } });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(output).toBe('8\n9\n10');   // 尾保留 3 行；末尾换行不算第 4 行，被截掉的正是它
		expect(result.value.truncation.truncated).toBe(true);
		expect(result.value.truncation.truncatedBy).toBe('lines');
		expect(result.value.truncation.totalLines).toBe(10);
	});

	it('stderr 与 stdout 合入同一视图（上游 Node 实现同样合并）', async () => {
		const { output } = await execWithOutput(newEnv(), 'echo out; echo err >&2');
		expect(output).toContain('out\n');
		expect(output).toContain('err\n');
	});
});

describe('exec：shell:false 占位', () => {
	it('恒返回 shell_unavailable（不抛）', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }], shell: false });
		const r: Result<unknown, ExecutionError> = await env.exec('ls', undefined, CTX);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('shell_unavailable');
	});
});
