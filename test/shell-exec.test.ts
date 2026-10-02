// @vitest-environment node
// spec §3.2/§4.2：exec 接线 wasi-sh busybox。vitest 是 node env（无 Worker 全局）→ 走 inline 路径；
// worker/硬杀路径的自动化不在 M3 闸门内（spec §4.2：以 spike 真浏览器实测 + 代码评审为据）。
// Task 6：契约换成 1.0.0 的 onOutput/spill（呈现归调用方），补 4 条 Review Focus 测试（#1 #2 #5 + onOutput 拼接）。
import { afterEach, describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, withAbortSignal } from '../src/env/context';
import { err, FileError, type ExecutionError, type Result } from '@earendil-works/pi-durable/env';
import type { ExecutionEnv } from '../src/env/types';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { execWithOutput } from './helpers/shell-output';

const CTX = BACKGROUND_CONTEXT;
const getOrFail = <T>(r: Result<T, { code: string; message: string }>): T => {
	if (!r.ok) throw new Error(`expected ok: ${r.error.code} ${r.error.message}`);
	return r.value;
};

/** 本文件造出的 env 统一收尾：新测试一度忘了 cleanup，与文件其余部分的自律相反 */
const liveEnvs: ExecutionEnv[] = [];

/** 与其它实例零共享的 env：显式独立挂载表，不走默认 IDB 注册表（否则同 dbName 的两个 env 会同世界） */
const isolatedEnv = (): ExecutionEnv => {
	const env = createBrowserExecutionEnv({
		mounts: [
			{ prefix: '/', fs: createMemoryFileSystem('/') },
			{ prefix: '/tmp', fs: createMemoryFileSystem('/tmp') },
		],
	});
	liveEnvs.push(env);
	return env;
};

afterEach(async () => {
	await Promise.all(liveEnvs.splice(0).map((env) => env.cleanup(BACKGROUND_CONTEXT)));
});

describe('exec：busybox inline 路径', () => {
	it('默认 shell=busybox：echo 返回 ok、退出码 0、stdout 经 onOutput 交付', async () => {
		const { result, output, truncation } = await execWithOutput(isolatedEnv(), 'echo hello');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.exitCode).toBe(0);
		expect(output).toBe('hello\n');
		expect(truncation.truncated).toBe(false);
		expect(result.value.spillPath).toBeUndefined();
	});

	it('退出码透传（exit 7），运行结束无异常', async () => {
		const { result } = await execWithOutput(isolatedEnv(), 'exit 7');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.exitCode).toBe(7);
	});

	it('cwd 存在时命令在 cwd 下跑；不存在 → spawn_error（不抛）', async () => {
		const env = isolatedEnv();
		getOrFail(await env.createDir('/d', { recursive: true }, CTX));
		const { result, output } = await execWithOutput(env, 'pwd', { cwd: '/d' });
		expect(result.ok).toBe(true);
		expect(output).toBe('/d\n');

		const missing = await env.exec('pwd', { cwd: '/nope' }, CTX);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe('spawn_error');
	});

	it('调用前已 abort → aborted（inline 无中断通道，只做调用前检查）', async () => {
		const env = isolatedEnv();
		const aborted = await env.exec('echo never', undefined, withAbortSignal(AbortSignal.abort(), CTX));
		expect(aborted.ok).toBe(false);
		if (!aborted.ok) expect(aborted.error.code).toBe('aborted');
	});

	it('run 边界：宿主写 guest 读到，guest 写落回宿主 fs（含 mkdir 与删除）', async () => {
		const root = createMemoryFileSystem('/');
		getOrFail(await root.writeFile('/in.txt', 'js-side', CTX));
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: root }] });

		const first = await execWithOutput(env, 'cat /in.txt');
		expect(first.output).toBe('js-side');

		const second = await execWithOutput(env, 'mkdir -p /out && echo made > /out/f.txt && rm /in.txt');
		expect(second.result.ok).toBe(true);
		expect(getOrFail(await root.readTextFile('/out/f.txt', CTX))).toBe('made\n');
		expect(getOrFail(await root.exists('/in.txt', CTX))).toBe(false);
	});

	it('截断现在是调用方的事：默认上限下 seq 1 10 原样，超限由 OutputAccumulator 决定', async () => {
		const { result, output, truncation } = await execWithOutput(isolatedEnv(), 'seq 1 10');
		expect(result.ok).toBe(true);
		expect(output).toBe('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
		expect(truncation.truncated).toBe(false);
	});

	it('stderr 与 stdout 合入同一路（上游 Node 实现同样合并）', async () => {
		const { output } = await execWithOutput(isolatedEnv(), 'echo out; echo err >&2');
		expect(output).toContain('out\n');
		expect(output).toContain('err\n');
	});
});

describe('exec：onOutput / spill（1.0.0 契约）', () => {
	// Review Focus：分片拼接等于完整 stdout
	it('onOutput 收到原始解码分片，拼接等于完整 stdout', async () => {
		const env = isolatedEnv();
		const chunks: string[] = [];
		const r = await env.exec("printf 'a\\nb\\n'", { onOutput: (text) => chunks.push(text) }, BACKGROUND_CONTEXT);
		expect(r.ok).toBe(true);
		expect(chunks.join('')).toBe('a\nb\n');
	});

	// 回归：分片边界落在多字节字符中间时，流式解码器会吐出空串；上游显式跳过空串。
	it('onOutput 不交付空串（多字节字符跨分片）', async () => {
		const env = isolatedEnv();
		const chunks: string[] = [];
		// 分两次写 UTF-8 的 '中'（E4 B8 AD）+ 换行，逼解码器在分片边界上扣住不完整的序列
		const r = await env.exec("printf '\\344'; printf '\\270\\255\\n'", { onOutput: (text) => chunks.push(text) }, BACKGROUND_CONTEXT);
		expect(r.ok).toBe(true);
		expect(chunks.join('')).toBe('中\n');
		expect(chunks).not.toContain('');
	});

	// 回归：消费者 onOutput 抛错曾被当成 spawn_error（inline）或被无人接（worker）——上游转成 callback_error。
	it('消费者 onOutput 抛错 → callback_error（不误标成 spawn_error）', async () => {
		const env = isolatedEnv();
		const r = await env.exec('echo hi', { onOutput: () => { throw new Error('consumer boom'); } }, BACKGROUND_CONTEXT);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('callback_error');
	});

	it('spill 阈值触发时结果带 spillPath，且同一 env 读得到全文', async () => {
		const env = isolatedEnv();
		const r = await env.exec('seq 1 500', { spill: { afterBytes: 16, afterLines: 5 } }, BACKGROUND_CONTEXT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const path = r.value.spillPath;
		expect(path?.startsWith('/tmp/')).toBe(true);
		const read = await env.readTextFile(path!, BACKGROUND_CONTEXT);
		expect(read.ok).toBe(true);
		if (read.ok) {
			expect(read.value.trimEnd().split('\n')).toHaveLength(500);
			expect(read.value).toContain('500');
		}
	});

	it('未设 spill 阈值时不产生 spillPath', async () => {
		const env = isolatedEnv();
		const r = await env.exec('echo hi', undefined, BACKGROUND_CONTEXT);
		expect(r.ok && r.value.spillPath).toBeUndefined();
	});

	// Review Focus #1：spillPath 是 env 内虚拟路径，跨 env 读不到
	it('spillPath 是 env 内虚拟路径，另一个 env 读不到', async () => {
		const a = isolatedEnv();
		const r = await a.exec('seq 1 500', { spill: { afterBytes: 16, afterLines: 5 } }, BACKGROUND_CONTEXT);
		if (!r.ok || !r.value.spillPath) throw new Error('未触发 spill');
		const b = isolatedEnv();   // 与 a 零共享
		const read = await b.readTextFile(r.value.spillPath, BACKGROUND_CONTEXT);
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.code).toBe('not_found');
	});

	// Review Focus #2：abort 之后 exec 不挂住（inline 无中断通道，shell 仍跑完——spec §4.5 的语义豁免；
	// 「立即收尾/不再回调」只对 worker 路径成立，那条路径由浏览器 e2e 覆盖）
	it('onOutput 里 abort：inline 不中断 shell，但 exec 不挂住、最终正常返回', async () => {
		const env = isolatedEnv();
		const controller = new AbortController();
		const ctx = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		let calls = 0;
		const raced = await Promise.race([
			env.exec('seq 1 200000', { onOutput: () => { calls++; controller.abort(); } }, ctx),
			new Promise<string>((resolve) => setTimeout(() => resolve('HANG'), 30000)),
		]);
		if (typeof raced === 'string') throw new Error(`exec 在 abort 后挂住了（${raced}）`);
		expect(raced.ok).toBe(true);
		expect(calls).toBeGreaterThan(0);
	}, 40000);

	// 回归：spill 落盘失败曾经直接逃出 exec（inline 路径的 finalize 不在 try 里）——既把 shell 错误变成
	// 不透明 reject，又跳过 pullAndApply 把 guest 的文件写入一起丢掉。调用方契约是「永远返回 Result」。
	it('spill 落盘失败时返回错误 Result 而不是 reject', async () => {
		const tmp = createMemoryFileSystem('/tmp');
		const failWrite = async (): Promise<Result<void, FileError>> => err<void, FileError>(new FileError('unknown', 'disk full'));
		const env = createBrowserExecutionEnv({
			mounts: [
				{ prefix: '/', fs: createMemoryFileSystem('/') },
				{ prefix: '/tmp', fs: { ...tmp, writeFile: failWrite, appendFile: failWrite } },
			],
		});
		const r = await env.exec('seq 1 500', { spill: { afterBytes: 16, afterLines: 5 } }, BACKGROUND_CONTEXT);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('unknown');
	});

	// Review Focus #5：cleanup 后 exec 响亮失败
	it('cleanup 之后再 exec 返回错误而不是挂住', async () => {
		const env = isolatedEnv();
		await env.cleanup(BACKGROUND_CONTEXT);
		const raced = await Promise.race([
			env.exec('echo hi', undefined, BACKGROUND_CONTEXT),
			new Promise<string>((resolve) => setTimeout(() => resolve('HANG'), 2000)),
		]);
		if (typeof raced === 'string') throw new Error(`exec 在 cleanup 后挂住了（${raced}）`);
		expect(raced.ok).toBe(false);
		if (!raced.ok) expect(raced.error.code).toBe('shell_unavailable');
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
