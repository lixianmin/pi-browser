// @vitest-environment node
// 代码评审回归集（2026-10-17）：每条用例对应 src/ 里一个已确认缺陷，全部先红后绿。
// 分组与修复一一对应，断言只看可观察契约（返回值 / 宿主 fs 状态 / 输出文本）。
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { ExecutionError, FileError, type Result } from '@earendil-works/pi-durable/env';
import type { Context } from '../src/env/context';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import type { BrowserFileSystem, ExecutionEnv } from '../src/env/types';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { createMountTable } from '../src/env/mount';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { applyChanges } from '../src/shell/sync-session';
import { asDurableTool } from '../src/tools/durable-tool';
import { createBashTool } from '../src/tools/bash-tool';
import { createGrepTool } from '../src/tools/grep-tool';
import { createLsTool } from '../src/tools/ls-tool';
import { createFindTool } from '../src/tools/find-tool';
import { GREP_MAX_LINE_LENGTH, truncateLine } from '../src/tools/truncate';
import { findOps, grepOps, lsOps } from './helpers/tool-operations';

const CTX = BACKGROUND_CONTEXT;
const ENC = new TextEncoder();

const getOrFail = <T>(r: Result<T, FileError>): T => {
	if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
	return r.value;
};
const textOf = (r: { content: { type: string; text?: string }[] }): string =>
	r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');

// ───────────────────────── tools ─────────────────────────

describe('tools 回归', () => {
	it('asDurableTool 把调用方 Context 的 abortSignal 传给 AgentTool.execute', async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const tool = {
			name: 'probe',
			description: 'probe',
			parameters: Type.Object({}),
			execute: async (_id: string, _input: unknown, signal?: AbortSignal) => {
				seen = signal;
				return { content: [{ type: 'text', text: 'ok' }] };
			},
		} as unknown as AgentTool<any>;
		const api = { callId: 'c1', output: () => {} } as unknown as ToolExecutionApi;
		const context = { abortSignal: controller.signal, value: () => undefined, toString: () => 'ctx' } as Context;

		await asDurableTool(tool).execute({}, api, context);
		expect(seen).toBe(controller.signal);
	});

	it('bash：timeout / aborted 时保留已收到的输出（并保留 ExecutionError 码）', async () => {
		const ops = {
			exec: async (_command: string, _cwd: string, options: { onData(data: Uint8Array): void }) => {
				options.onData(ENC.encode('partial line\n'));
				throw new ExecutionError('timeout', 'timeout:5');
			},
		};
		const tool = createBashTool('/', { operations: ops });
		await expect(tool.execute('id', { command: 'make', timeout: 5 })).rejects.toMatchObject({
			code: 'timeout',
			message: expect.stringContaining('partial line'),
		});
	});

	it('grep：相邻命中共享的上下文行只输出一次', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/f.txt', 'a\nX\nb\nX\nc\n', CTX);
		const out = textOf(await createGrepTool('/', { fs, operations: grepOps(fs) }).execute('id', { pattern: 'X', path: 'f.txt', context: 1 }));

		expect(out.split('\n').filter((line) => line.startsWith('f.txt-3-'))).toHaveLength(1);
	});

	it('grep：相邻两行都命中时，共享行只输出一次且标成命中行', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/g.txt', 'a\nX\nX\nb\n', CTX);
		const out = textOf(await createGrepTool('/', { fs, operations: grepOps(fs) }).execute('id', { pattern: 'X', path: 'g.txt', context: 1 }));

		const lines = out.split('\n');
		expect(lines).toContain('g.txt:2: X');
		expect(lines).toContain('g.txt:3: X');
		expect(lines.filter((line) => line === 'g.txt-3- X')).toHaveLength(0);
	});

	it('truncateLine 不把代理对切成孤立半个', () => {
		const line = `${'a'.repeat(GREP_MAX_LINE_LENGTH - 1)}😀x`;
		const { text } = truncateLine(line);
		expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it('ls limit:0 不再把非空目录报成 (empty directory)', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/d/a.txt', 'x', CTX);
		const out = textOf(await createLsTool('/', { operations: lsOps(fs) }).execute('id', { path: 'd', limit: 0 }));
		expect(out).not.toBe('(empty directory)');
	});

	it('find limit:0 不再把存在的文件报成未找到', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/d/a.ts', 'x', CTX);
		const out = textOf(await createFindTool('/', { operations: findOps(fs) }).execute('id', { pattern: '*.ts', path: 'd', limit: 0 }));
		expect(out).not.toBe('No files found matching pattern');
	});
});

// ───────────────────────── env 后端 ─────────────────────────

describe('env 后端回归', () => {
	it('memory：renameFile(path, path) 是成功 no-op，不删文件', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/a.txt', 'keep', CTX);

		expect((await fs.renameFile('/a.txt', '/a.txt', CTX)).ok).toBe(true);
		expect(getOrFail(await fs.readTextFile('/a.txt', CTX))).toBe('keep');
	});

	it('memory：rename 目录时整棵子树跟着换路径', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/d/x.txt', 'x', CTX);

		expect((await fs.renameFile('/d', '/d2', CTX)).ok).toBe(true);
		expect(getOrFail(await fs.readTextFile('/d2/x.txt', CTX))).toBe('x');
		expect((await fs.readTextFile('/d/x.txt', CTX)).ok).toBe(false);
	});

	it('memory：rename 到「文件之下」报 not_directory，不制造脏节点', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/f', 'file', CTX);
		await fs.writeFile('/a', 'a', CTX);

		const r = await fs.renameFile('/a', '/f/child', CTX);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('not_directory');
	});

	it('memory：FileInfo.size 报 UTF-8 字节数（与 readBinaryFile 一致）', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/cn.txt', '中文', CTX);

		expect(getOrFail(await fs.fileInfo('/cn.txt', CTX)).size).toBe(6);
		expect(getOrFail(await fs.readBinaryFile('/cn.txt', CTX))).toHaveLength(6);
	});

	it('memory：truncateFile 对不可分配的超大 size 返回 Result 错误，不 reject', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/a.txt', 'x', CTX);

		const r = await fs.truncateFile('/a.txt', Number.MAX_SAFE_INTEGER, CTX);
		expect(r.ok).toBe(false);
	});

	it('memory：readBinaryFile 返回副本，调用方改字节不影响存储', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/b.bin', new Uint8Array([1, 2, 3]), CTX);

		const first = getOrFail(await fs.readBinaryFile('/b.bin', CTX));
		first[0] = 99;
		expect([...getOrFail(await fs.readBinaryFile('/b.bin', CTX))]).toEqual([1, 2, 3]);
	});

	it('memory：rename 根被拒绝，整棵树留在原处', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/a.txt', 'x', CTX);

		expect((await fs.renameFile('/', '/moved', CTX)).ok).toBe(false);
		expect(getOrFail(await fs.readTextFile('/a.txt', CTX))).toBe('x');
	});

	it('memory：remove("/", { recursive: true }) 被拒绝，根不被删掉', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/a.txt', 'x', CTX);

		const r = await fs.remove('/', { recursive: true }, CTX);
		expect(r.ok).toBe(false);
		expect(getOrFail(await fs.exists('/a.txt', CTX))).toBe(true);
	});

	it('mount：挂载根的 canonicalPath / openDirReader 与 exists 口径一致', async () => {
		const table = createMountTable([
			{ prefix: '/', fs: createMemoryFileSystem() },
			{ prefix: '/tmp', fs: createMemoryFileSystem() },
		]);

		expect(getOrFail(await table.canonicalPath('/tmp', CTX))).toBe('/tmp');
		const reader = getOrFail(await table.openDirReader('/tmp', CTX));
		expect((await reader.next(10, CTX)).ok).toBe(true);
	});

	it('applyChanges：不把挂载根本身写进后端（不产生 /tmp 挂载里的空壳目录）', async () => {
		const root = createMemoryFileSystem();
		const tmp = createMemoryFileSystem();
		const store = { mounts: [{ prefix: '/', fs: root }, { prefix: '/tmp', fs: tmp }] };

		await applyChanges(store, { deleted: [], dirs: ['/tmp'], written: [] });
		// /tmp 由挂载表应答；后端里不该多出同名目录
		expect((await tmp.fileInfo('/tmp', CTX)).ok).toBe(false);
	});
});

// ───────────────────────── shell / exec ─────────────────────────

describe('shell 回归', () => {
	const liveEnvs: ExecutionEnv[] = [];
	const envWith = (mounts: { prefix: string; fs: BrowserFileSystem }[]): ExecutionEnv => {
		const env = createBrowserExecutionEnv({ mounts });
		liveEnvs.push(env);
		return env;
	};
	afterEach(async () => {
		await Promise.all(liveEnvs.splice(0).map((env) => env.cleanup(CTX)));
	});

	it('默认 cwd 取挂载表的根（"/" 挂载），而不是第一个注册的挂载', async () => {
		const env = envWith([
			{ prefix: '/tmp', fs: createMemoryFileSystem('/scratch') },
			{ prefix: '/', fs: createMemoryFileSystem('/') },
		]);
		let stdout = '';
		const r = await env.exec('pwd', { onOutput: (text) => { stdout += text; } }, CTX);
		expect(r.ok).toBe(true);
		expect(stdout.trim()).toBe('/');
	});

	it('decoder 收尾的 onOutput 抛错 → callback_error（不再误报 spill 落盘失败）', async () => {
		const env = envWith([{ prefix: '/', fs: createMemoryFileSystem() }]);
		// 只发一个不完整的多字节序列：流式解码先吐空串，收尾 decode() 才吐出替换字符 → 走 finalize 分支
		const r = await env.exec("printf '\\xE4\\xB8'", { onOutput: () => { throw new Error('consumer boom'); } }, CTX);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('callback_error');
	});

	it('Worker 构造抛错（CSP/跨源）时 exec 返回 Result，不向外抛', async () => {
		const g = globalThis as { Worker?: unknown };
		const saved = g.Worker;
		g.Worker = class {
			constructor() { throw new Error('blocked by CSP'); }
		};
		try {
			const env = createBrowserExecutionEnv({
				mounts: [{ prefix: '/', fs: createMemoryFileSystem() }],
				workerUrl: 'https://example.com/worker.js',
			});
			liveEnvs.push(env);
			const r = await env.exec('echo hi', undefined, CTX);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.code).toBe('spawn_error');
		} finally {
			if (saved === undefined) delete g.Worker;
			else g.Worker = saved;
		}
	});
});

// ───────────────── 第二轮评审（2026-10-17）：上轮修复的回归 + 新发现 ─────────────────

describe('shell 对账：类型变化与目录回写', () => {
	it('reconcilePulled：文件↔目录类型变化必须进 deleted（applyChanges 前先删旧节点）', async () => {
		const { reconcilePulled } = await import('../src/shell/exec');
		const pushed = {
			deleted: [],
			dirs: ['/d'],
			written: [{ path: '/f', data: ENC.encode('x') }],
		};
		const pulled = {
			deleted: [],
			dirs: ['/f'],
			written: [{ path: '/d', data: ENC.encode('y') }],
		};
		const r = reconcilePulled(pushed, pulled);
		expect(r.deleted).toEqual(expect.arrayContaining(['/d', '/f']));
		expect(r.dirs).toEqual(['/f']);
	});

	it('reconcilePulled：已存在于宿主的目录不重复 createDir', async () => {
		const { reconcilePulled } = await import('../src/shell/exec');
		const pushed = { deleted: [], dirs: ['/w', '/w/sub'], written: [] };
		const pulled = { deleted: [], dirs: ['/w', '/w/sub', '/w/new'], written: [] };
		expect(reconcilePulled(pushed, pulled).dirs).toEqual(['/w/new']);
	});
});

describe('env：路径穿过文件 / BOM / scanLines / 自我 rename', () => {
	it('memory：truncateFile / flushFile 对「路径穿过文件」报 not_directory', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/f', 'file', CTX);

		const t = await fs.truncateFile('/f/child', 1, CTX);
		expect(t.ok).toBe(false);
		if (!t.ok) expect(t.error.code).toBe('not_directory');
		const f = await fs.flushFile('/f/child', CTX);
		expect(f.ok).toBe(false);
		if (!f.ok) expect(f.error.code).toBe('not_directory');
	});

	it('IDB/lightning 后端：自我 rename 不删文件；缺失路径的自我 rename 仍 not_found', async () => {
		const { createBrowserFileSystem } = await import('../src/env/backend-idb');
		const fs = createBrowserFileSystem({ dbName: `r-self-${Math.random().toString(36).slice(2)}`, memory: false });
		await fs.writeFile('/a.txt', 'keep', CTX);

		expect((await fs.renameFile('/a.txt', '/a.txt', CTX)).ok).toBe(true);
		expect(getOrFail(await fs.readTextFile('/a.txt', CTX))).toBe('keep');
		const missing = await fs.renameFile('/missing', '/missing', CTX);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe('not_found');
	});

	it('createTextLineReader 吃掉文件开头的 BOM（对齐上游 StreamDecoder）', async () => {
		const { createTextLineReader } = await import('../src/env/text-line-reader');
		const reader = createTextLineReader('\uFEFFa\nb', '/x');
		const first = getOrFail(await reader.readLine(CTX));
		expect(first).toEqual({ text: 'a', terminated: true });
	});

	it('BinaryReader.scanLines 接受 endLine: Infinity（上游语义：到文件末尾）', async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile('/b.txt', 'l1\nl2\nl3\n', CTX);
		const reader = getOrFail(await fs.openBinaryReader('/b.txt', {}, CTX));
		const r = await reader.scanLines({ startLine: 0, endLine: Number.POSITIVE_INFINITY }, CTX);
		expect(r.ok).toBe(true);
	});
});

describe('shell：宿主命令与 exec 边界', () => {
	it('readStdin 读满整个 stdin（不再被 64KiB 单次上限截断）', async () => {
		const { createInlineHostBuiltins } = await import('../src/shell/host-commands');
		let seen: string | undefined;
		const builtins = createInlineHostBuiltins({
			probe: (req) => { seen = req.stdin; return { exitCode: 0 }; },
		});
		const chunks = [new Uint8Array(65536).fill(65), new Uint8Array(65536).fill(66), new Uint8Array(0)];
		let i = 0;
		const ctx = {
			argv: ['probe'], env: {}, cwd: '/',
			stdin: () => chunks[i++] ?? new Uint8Array(0),
			stdout: () => {}, stderr: () => {}, fs: {},
		};
		const status = builtins.run(ctx as never);
		expect(status).toBe(0);
		expect(seen).toHaveLength(131072);
	});

	it('宿主命令抛出的超长错误不会撑爆 SAB / 打死应答循环', async () => {
		const { createHostCommandChannel, createHostCommandSharedBuffer } = await import('../src/shell/host-commands');
		const { hostSide, guestSide } = createHostCommandChannel(createHostCommandSharedBuffer({ capacity: 1024 }));
		const seq = guestSide.send({ name: 'boom', args: [], cwd: '/', changes: { deleted: [], dirs: [], written: [] } });
		const responder = async () => { throw new Error('E'.repeat(4096)); };

		await expect(hostSide.respondOnce(responder)).resolves.toBe(true);
		const r = guestSide.read(seq);
		expect(r.exitCode).toBe(1);
		expect((r.stderr ?? '').length).toBeLessThan(1024);
		hostSide.stop();
	});

	it('非法 timeout（0 / 负数 / NaN）→ timeout 错误，不启动命令', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }] });
		try {
			for (const timeout of [0, -1, Number.NaN]) {
				const r = await env.exec('echo hi', { timeout }, CTX);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.error.code).toBe('timeout');
			}
		} finally {
			await env.cleanup(CTX);
		}
	});

	it('缺少 SharedArrayBuffer（未开 COOP/COEP）→ shell_unavailable，而不是模糊的 spawn_error', async () => {
		const g = globalThis as { Worker?: unknown; SharedArrayBuffer?: unknown };
		const savedWorker = g.Worker;
		const savedSab = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
		g.Worker = class { constructor() { throw new Error('should not construct'); } };
		Object.defineProperty(globalThis, 'SharedArrayBuffer', { value: undefined, configurable: true, writable: true });
		try {
			const env = createBrowserExecutionEnv({
				mounts: [{ prefix: '/', fs: createMemoryFileSystem() }],
				workerUrl: 'https://example.com/worker.js',
			});
			const r = await env.exec('echo hi', undefined, CTX);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.code).toBe('shell_unavailable');
			await env.cleanup(CTX);
		} finally {
			if (savedWorker === undefined) delete g.Worker; else g.Worker = savedWorker;
			if (savedSab) Object.defineProperty(globalThis, 'SharedArrayBuffer', savedSab);
		}
	});

	it('cleanup 在 spawn 就绪前发生 → aborted，不等 30s readyTimeout', async () => {
		const { createBusyboxShell } = await import('../src/shell/exec');
		const g = globalThis as { Worker?: unknown };
		const saved = g.Worker;
		vi.useFakeTimers();
		let started!: () => void;
		const spawnStarted = new Promise<void>((resolve) => { started = resolve; });
		g.Worker = class {
			postMessage(msg: { files?: unknown }): void { if (msg && 'files' in msg) started(); }
			addEventListener(): void {}
			removeEventListener(): void {}
			terminate(): void {}
		};
		try {
			const fs = createMemoryFileSystem();
			const shell = createBusyboxShell({ mounts: [{ prefix: '/', fs }] }, { workerUrl: 'https://example.com/worker.js', hostCommands: {} });
			const running = shell.exec('echo hi', undefined, CTX);
			await spawnStarted;
			await shell.cleanup(CTX);
			const r = await running;
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.code).toBe('aborted');
		} finally {
			vi.useRealTimers();
			if (saved === undefined) delete g.Worker; else g.Worker = saved;
		}
	});
});
