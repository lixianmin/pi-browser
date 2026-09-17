// @vitest-environment node
// S2.1 spec §4：宿主命令 seam 的两层测试。
//   协议层（不起真 Worker）：假宿主驱动 SAB 两端——往返、超时、大响应截断、处理器抛错、FS 对账（§3.3 的双向）。
//   inline 层：同步纯处理器可被管道组合；async / 有 FS 效果的处理器明确报错（必须走 worker 路径）。
// guest 侧的阻塞等待（`wait`/`call` 的成功路径）只在真 worker 里跑得通——单线程下它会让宿主侧没机会应答，
// 所以那条路径由浏览器 e2e 覆盖（S2 既有豁免），这里只测「无人应答 → 超时抛错」。
import { describe, it, expect } from 'vitest';
import { applyShellOutputUpdate, BACKGROUND_CONTEXT, type ExecutionEnv, type ShellOutputUpdate, type ShellOutputView } from '@earendil-works/pi-agent-core';
import type { BuiltinContext } from 'wasi-sh';
import { createBrowserExecutionEnv } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import {
	createGuestHostBuiltins, createHostCommandChannel, createHostCommandResponder, createHostCommandSharedBuffer,
	hostCommandNames, type HostCommandExchangeRequest, type HostCommandRegistry,
} from '../src/shell/host-commands';
import { createWasiFileSystem, type WasiFileSystem, type WasiFsChanges } from '../src/shell/wasi-fs';

const CTX = BACKGROUND_CONTEXT;
const ENC = new TextEncoder();
const EMPTY: WasiFsChanges = { deleted: [], dirs: [], written: [] };

const storeOf = (fs = createMemoryFileSystem()) => ({ mounts: [{ prefix: '/', fs }] });

const envWith = (hostCommands?: HostCommandRegistry, fs = createMemoryFileSystem()) =>
	createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs }], hostCommands });

/** 命令输出只经 onUpdate 交付（ShellExecResult 里只有 exitCode + 截断元数据），与 shell-exec.test 同法累积 */
async function execWithOutput(env: ExecutionEnv, command: string) {
	let view: ShellOutputView | undefined;
	const result = await env.exec(command, { onUpdate: (update: ShellOutputUpdate) => { view = applyShellOutputUpdate(view, update); } }, CTX);
	return { result, output: view?.text ?? '' };
}

/** 从 guest 缓存同步读一个文件（adapter 的读接口是 run 期唯一的同步真相） */
function readGuest(guestFs: WasiFileSystem, path: string): string {
	const { size } = guestFs.statSync(path);
	const bytes = new Uint8Array(size);
	guestFs.readSync(path, bytes, 0, size);
	return new TextDecoder().decode(bytes);
}

describe('宿主命令协议（假宿主驱动两端）', () => {
	it('请求/响应往返 + stop 之后不再应答', async () => {
		const { hostSide, guestSide } = createHostCommandChannel(createHostCommandSharedBuffer());
		const respond = createHostCommandResponder(storeOf(), { hello: (req) => ({ exitCode: 0, stdout: `hello ${req.args.join(' ')}\n` }) });

		const seq = guestSide.send({ name: 'hello', args: ['world'], cwd: '/', changes: EMPTY });
		await expect(hostSide.respondOnce(respond)).resolves.toBe(true);
		expect(guestSide.read(seq)).toEqual({ exitCode: 0, stdout: 'hello world\n', stderr: undefined, changes: EMPTY });

		hostSide.stop();
		await expect(hostSide.respondOnce(respond)).resolves.toBe(false);
	});

	it('超时：无人应答时 guest 的等待抛错，且未就绪的读直接抛错', () => {
		const { guestSide } = createHostCommandChannel(createHostCommandSharedBuffer(), { timeoutMs: 20 });
		const seq = guestSide.send({ name: 'hang', args: [], cwd: '/', changes: EMPTY });

		expect(() => guestSide.wait(seq)).toThrow(/未应答/);
		expect(() => guestSide.read(seq)).toThrow(/未就绪/);
	});

	it('大响应截断：stdout 被截短，stderr 保留原文并追加截断说明', async () => {
		const { hostSide, guestSide } = createHostCommandChannel(createHostCommandSharedBuffer({ capacity: 512 }));
		const respond = createHostCommandResponder(storeOf(), {
			big: () => ({ exitCode: 0, stdout: 'x'.repeat(4000), stderr: '原始 stderr' }),
		});

		const seq = guestSide.send({ name: 'big', args: [], cwd: '/', changes: EMPTY });
		await hostSide.respondOnce(respond);
		const response = guestSide.read(seq);

		expect(response.exitCode).toBe(0);
		expect(response.stdout?.length ?? 0).toBeLessThan(4000);
		expect(response.stderr).toContain('原始 stderr');
		expect(response.stderr).toMatch(/截断/);
		hostSide.stop();
	});

	it('处理器抛错 → exitCode=1 + stderr 摘要（不挂死 worker）', async () => {
		const { hostSide, guestSide } = createHostCommandChannel(createHostCommandSharedBuffer());
		const respond = createHostCommandResponder(storeOf(), {
			boom: () => { throw new Error('炸了'); },
		});

		const seq = guestSide.send({ name: 'boom', args: [], cwd: '/', changes: EMPTY });
		await hostSide.respondOnce(respond);

		expect(guestSide.read(seq)).toMatchObject({ exitCode: 1, stderr: 'boom: 炸了\n' });
		hostSide.stop();
	});

	it('FS 对账（§3.3）：guest 写 → 处理器读到；处理器写 → guest 立即读到', async () => {
		const hostFs = createMemoryFileSystem();
		const guestFs = createWasiFileSystem({ mounts: [] });   // worker 内 store 的替身（纯内存）
		// guest 本次 run 里写了一个文件
		guestFs.createFileSync('/from-guest.txt', { uid: 0, gid: 0, mode: 0o644 });
		guestFs.writeSync('/from-guest.txt', ENC.encode('guest 写的'), 0);

		const seen: string[] = [];
		const respond = createHostCommandResponder(storeOf(hostFs), {
			probe: async (_req, fs) => {
				const read = await fs.readTextFile('/from-guest.txt', CTX);   // 处理器读 guest 刚写下的内容
				seen.push(read.ok ? read.value : `err:${read.error.code}`);
				const written = await fs.writeFile('/from-host.txt', '宿主写的', CTX);
				return { exitCode: written.ok ? 0 : 1 };
			},
		});

		const { hostSide, guestSide } = createHostCommandChannel(createHostCommandSharedBuffer());
		const seq = guestSide.send({ name: 'probe', args: [], cwd: '/', changes: guestFs.exportChanges() });
		await hostSide.respondOnce(respond);
		const response = guestSide.read(seq);
		guestFs.applyChanges(response.changes);

		expect(seen).toEqual(['guest 写的']);
		expect(await hostFs.readTextFile('/from-guest.txt', CTX)).toMatchObject({ ok: true, value: 'guest 写的' });
		expect(response.exitCode).toBe(0);
		expect(readGuest(guestFs, '/from-host.txt')).toBe('宿主写的');
		expect(guestFs.exportChanges()).toEqual(EMPTY);   // 宿主自己的写不会被当成 guest 变更重复回传
		hostSide.stop();
	});

	it('未注册的名字 → 127（worker 里的名字清单与主线程注册表一致，这是兜底）', async () => {
		const { hostSide, guestSide } = createHostCommandChannel(createHostCommandSharedBuffer());
		const respond = createHostCommandResponder(storeOf(), {});

		const seq = guestSide.send({ name: 'ghost', args: [], cwd: '/', changes: EMPTY });
		await hostSide.respondOnce(respond);

		expect(guestSide.read(seq)).toMatchObject({ exitCode: 127, stderr: 'ghost: not found\n' });
		hostSide.stop();
	});
});

describe('注册名校验：与 applet/ash 内建同名 → 抛错', () => {
	it('applet 名（ls）在创建 env 时就抛错；git 这类新名字照常过', () => {
		expect(() => envWith({ ls: () => ({ exitCode: 0 }) })).toThrow(/ls/);
		expect(() => envWith({ cd: () => ({ exitCode: 0 }) })).toThrow(/cd/);
		expect(hostCommandNames({ git: () => ({ exitCode: 0 }) })).toEqual(['git']);
	});
});

describe('inline 路径（同步纯处理器）', () => {
	it('宿主命令被 guest 调用，并可被管道组合（hello world | wc -c）', async () => {
		const env = envWith({ hello: (req) => ({ exitCode: 0, stdout: `hello ${req.args.join(' ')}\n` }) });

		const { result, output } = await execWithOutput(env, 'hello world | wc -c');

		expect(result.ok && result.value.exitCode).toBe(0);
		expect(output.trim()).toBe('12');
		await env.cleanup(CTX);
	});

	it('退出码/环境/cwd 原样传给处理器；管道输入经 stdin 可读，无输入时 stdin 缺省', async () => {
		const requests: { stdin?: string; cwd: string; env?: Record<string, string>; args: string[] }[] = [];
		const env = envWith({
			pick: (req) => {
				requests.push({ stdin: req.stdin, cwd: req.cwd, env: req.env, args: req.args });
				return req.args.includes('--fail') ? { exitCode: 7, stderr: 'nope\n' } : { exitCode: 0, stdout: `${req.stdin ?? ''}|${req.cwd}\n` };
			},
		});

		const piped = await execWithOutput(env, 'printf abc | FOO=1 pick x');
		const bare = await execWithOutput(env, 'pick');
		const failed = await execWithOutput(env, 'pick --fail');

		expect(piped.output.trim()).toBe('abc|/');
		expect(bare.output.trim()).toBe('|/');
		expect(requests[0]).toMatchObject({ stdin: 'abc', cwd: '/', args: ['x'], env: { FOO: '1' } });
		expect(requests[1]?.stdin).toBeUndefined();
		expect(failed.result.ok && failed.result.value.exitCode).toBe(7);
		expect(failed.output).toBe('nope\n');
		await env.cleanup(CTX);
	});

	it('异步处理器 → 明确错误（inline 没有第二个线程可停靠）', async () => {
		const env = envWith({ later: async () => ({ exitCode: 0, stdout: '不该出现' }) });

		const { result, output } = await execWithOutput(env, 'later');

		expect(result.ok && result.value.exitCode).toBe(1);
		expect(output).toMatch(/worker 路径/);
		expect(output).not.toContain('不该出现');
		await env.cleanup(CTX);
	});

	it('处理器访问 fs → 明确错误（有 FS 效果必须走 worker 路径）', async () => {
		const env = envWith({ peeker: (_req, fs) => { fs.readTextFile('/a.txt', CTX); return { exitCode: 0 }; } });

		const { result, output } = await execWithOutput(env, 'peeker');

		expect(result.ok && result.value.exitCode).toBe(1);
		expect(output).toMatch(/worker 路径/);
		await env.cleanup(CTX);
	});
});

describe('worker 侧 glue（假通道，不起 worker）', () => {
	it('drain 变更集发给宿主；应答的 stdout/stderr/exitCode 与写回的变更按 §3.3 落地', () => {
		const guestFs = createWasiFileSystem({ mounts: [] });
		guestFs.createFileSync('/guest.txt', { uid: 0, gid: 0, mode: 0o644 });
		guestFs.writeSync('/guest.txt', ENC.encode('guest'), 0);

		const requests: HostCommandExchangeRequest[] = [];
		const builtins = createGuestHostBuiltins(guestFs, {
			send: () => 1,
			wait: () => { /* 假通道：应答现成 */ },
			read: () => ({ exitCode: 0, changes: EMPTY }),
			call: (request) => {
				requests.push(request);
				return {
					exitCode: 3,
					stdout: 'host out\n',
					stderr: 'host err\n',
					changes: { deleted: [], dirs: [], written: [{ path: '/from-host.txt', data: ENC.encode('host') }] },
				};
			},
		}, ['push']);

		expect(builtins.lookup('push')).toBe(true);
		expect(builtins.lookup('ls')).toBe(false);   // 没注册的名字留给 applet 解析

		const out: string[] = [];
		const err: string[] = [];
		const ctx = {
			argv: ['push', 'a'],
			cwd: '/sub',
			env: { A: '1' },
			stdin: () => ENC.encode('piped'),
			stdout: (bytes: string | Uint8Array) => out.push(String(bytes)),
			stderr: (bytes: string | Uint8Array) => err.push(String(bytes)),
			interrupted: () => false,
			fs: {},   // 宿主命令不走 wasi-sh 的 ctx.fs（fs 面走 channel 的对账）
		} as unknown as BuiltinContext;

		expect(builtins.run(ctx)).toBe(3);
		expect(out).toEqual(['host out\n']);
		expect(err).toEqual(['host err\n']);
		expect(requests[0]).toMatchObject({ name: 'push', args: ['a'], cwd: '/sub', stdin: 'piped', env: { A: '1' } });
		expect(requests[0]?.changes.written.map((w) => w.path)).toEqual(['/guest.txt']);
		expect(readGuest(guestFs, '/from-host.txt')).toBe('host');
	});
});
