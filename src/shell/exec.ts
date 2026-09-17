// src/shell/exec.ts —— busybox shell 后端：`Shell.exec` 映射到 wasi-sh 的 run()/spawn()（spec §3.2）。
//
// 两轨（线程模型）：
//   node/vitest（无 Worker 全局）→ `run({inline:true, fs: guestFs})`：主线程同步跑，run 边界同步见 sync-session。
//   浏览器（有 Worker 全局）→ `new Worker(workerUrl)` + `spawn()`：worker 内 `serve({fs})` 持有纯内存 store；
//     timeout/abort 走 `terminate()` 硬杀（inline 没有中断通道，只能做调用前 abort 检查）。
import { ExecutionError, err, ok, toError, type Context, type Result, type Shell, type ShellExecOptions, type ShellExecResult } from '@earendil-works/pi-agent-core';
import { run, type RunResult } from 'wasi-sh';
import { spawn, type Session } from 'wasi-sh/spawn';
import { isDir } from 'wasi-sh/fs';
import { normalizePath } from '../env/path';
import { ShellCapture } from './capture';
import { applyChanges, createSyncSession } from './sync-session';
import {
	PULL_CHANGES, readMountTree,
	type ChangesResponse, type PullChangesRequest, type ShellFsStore, type WasiFsChanges,
} from './wasi-fs';

export interface BusyboxShellOptions {
	/**
	 * 浏览器 worker 模块 URL（宿主打包器产物，形如
	 * `new Worker(new URL('@lixianmin/pi-browser/src/shell/worker.ts', import.meta.url), { type: 'module' })`）。
	 * 浏览器下必须给：fs 是活对象、不能结构化克隆进 worker，只能由自建 worker 模块 `serve({fs})` 注册。
	 */
	workerUrl?: URL | string;
}

/** 拉取 worker 变更集的等待上限：worker 死在回传前也不能把主线程挂住 */
const PULL_TIMEOUT_MS = 5000;

/** guest 初始 cwd 恒为 '/'（ash 的 pwd 实测），所以只有非 '/' 的 cwd 才需要前置 cd */
function withCwd(command: string, cwd: string): string {
	return cwd === '/' ? command : `cd ${quoteForShell(cwd)} && ${command}`;
}

/** 单引号包裹 + 内部单引号转义（cwd 来自宿主/guest 输入，不能裸拼） */
function quoteForShell(value: string): string {
	return `'${value.split("'").join("'\\''")}'`;
}

export function createBusyboxShell(store: ShellFsStore, options: BusyboxShellOptions = {}): Shell {
	/** 活着的 worker（浏览器路径）：cleanup 要能把它杀掉，否则页面刷新前一直挂着 */
	let liveWorker: Worker | undefined;

	const makeCapture = (execOptions: ShellExecOptions | undefined, context: Context): ShellCapture =>
		// capture.spill（超限全文落盘）不支持：pi-browser 没有 execution-environment-local 落盘面，传了忽略（spec §6）
		new ShellCapture({ limits: execOptions?.capture?.limits, onUpdate: execOptions?.onUpdate, context });

	const exec = async (command: string, execOptions: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> => {
		const capture = makeCapture(execOptions, context);
		const cwd = normalizePath(execOptions?.cwd ?? store.mounts[0]?.fs.cwd ?? '/');
		return typeof Worker === 'undefined'
			? await execInline(command, execOptions, context, capture, cwd)
			: await execInWorker(command, execOptions, context, capture, cwd);
	};

	/** 清空 guest 树并读回宿主 fs（run 边界的两端都在这里发生） */
	async function execInline(command: string, execOptions: ShellExecOptions | undefined, context: Context, capture: ShellCapture, cwd: string): Promise<Result<ShellExecResult, ExecutionError>> {
		const session = createSyncSession(store);
		try {
			await session.seed();
		} catch (e) {
			return err(new ExecutionError('spawn_error', `无法读取工作区: ${toError(e).message}`, toError(e)));
		}
		const cwdError = checkCwd(session.guestFs.statSync, cwd);
		if (cwdError) return err(cwdError);
		// inline 无中断通道（run() 同步占满线程、没有 input/interrupt 通道）：只做调用前 abort 检查；
		// timeout 同理不生效（没有能触发的定时器）——语义豁免见 spec §4.5
		if (context.abortSignal?.aborted) {
			capture.finish();
			return err(new ExecutionError('aborted', 'aborted'));
		}
		let result: RunResult;
		try {
			result = await run({
				command: withCwd(command, cwd),
				fs: session.guestFs,
				inline: true,
				env: envFor(execOptions),
				onOutput: (bytes) => capture.push(bytes),
			});
		} catch (e) {
			return err(new ExecutionError('spawn_error', toError(e).message, toError(e)));
		}
		capture.finish();
		try {
			await session.pullAndApply();
		} catch (e) {
			// guest 的写没落盘：宁可把这次运行报成失败，也不返回「看起来成功」的结果
			return err(new ExecutionError('unknown', toError(e).message, toError(e)));
		}
		return ok({ exitCode: result.exitCode, ...capture.metadata() });
	}

	async function execInWorker(command: string, execOptions: ShellExecOptions | undefined, context: Context, capture: ShellCapture, cwd: string): Promise<Result<ShellExecResult, ExecutionError>> {
		if (options.workerUrl === undefined) {
			return err(new ExecutionError('shell_unavailable', '浏览器下的 busybox 需要 workerUrl：fs 不能跨 postMessage，必须由自建 worker 模块 serve({fs}) 注册'));
		}
		// 硬杀语义（spec §3.2）：被杀运行的**文件变更整体丢弃**（变更集没拉），已发布的输出保留
		let killed: 'timeout' | 'aborted' | undefined;
		let session: Session | undefined;
		const kill = (why: 'timeout' | 'aborted'): void => {
			killed ??= why;
			session?.terminate();
		};
		const timer = execOptions?.timeout === undefined ? undefined : setTimeout(() => kill('timeout'), execOptions.timeout * 1000);
		const onAbort = (): void => kill('aborted');
		context.abortSignal?.addEventListener('abort', onAbort, { once: true });
		const worker = new Worker(options.workerUrl, { type: 'module' });
		liveWorker = worker;
		try {
			// 活着的 guest 收不到 postMessage，整树只能随启动消息（files）推给 worker；回传在 run 结束后拉
			const pushed = await readMountTree(store);
			const files: Record<string, string | Uint8Array> = {};
			for (const { path, data } of pushed.written) files[path] = data;
			session = await spawn({ worker, command: withCwd(command, cwd), env: envFor(execOptions), files });
			session.onOutput((bytes) => capture.push(bytes));
			const exitCode = await session.exited;
			capture.finish();
			if (killed === 'timeout') return err(new ExecutionError('timeout', `timeout:${execOptions?.timeout}`));
			if (killed === 'aborted') return err(new ExecutionError('aborted', 'aborted'));
			await applyChanges(store, await pulledChanges(worker, pushed));
			return ok({ exitCode, ...capture.metadata() });
		} catch (e) {
			capture.finish();
			return err(new ExecutionError('spawn_error', toError(e).message, toError(e)));
		} finally {
			if (timer) clearTimeout(timer);
			context.abortSignal?.removeEventListener('abort', onAbort);
			worker.terminate();   // 一次 exec 一个 worker（与 run() 同构），杀掉不留悬挂线程
			if (liveWorker === worker) liveWorker = undefined;
		}
	}

	const cleanup = async (): Promise<void> => {
		liveWorker?.terminate();
		liveWorker = undefined;
	};

	return { exec, cleanup };
}

/**
 * cwd 检查（spec §3.2：适配器 resolve 基准，不存在 → spawn_error）。
 * 顺带挡住「cwd 是个文件」——那同样起不了 shell。
 */
function checkCwd(statSync: (path: string) => { mode: number }, cwd: string): ExecutionError | undefined {
	try {
		const stat = statSync(cwd);
		if (!isDir(stat.mode)) return new ExecutionError('spawn_error', `Not a directory: ${cwd}`);
		return undefined;
	} catch {
		return new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}`);
	}
}

/**
 * env 映射：`run({env})`（wasi-sh 内部 mergeEnv：DEFAULT_ENV=PATH/HOME/TERM/LANG 之上叠宿主给的值）。
 * `inheritEnv:false` 的差异在浏览器里无法兑现——没有 process.env 可继承，而 DEFAULT_ENV 由 run() 无条件合并，
 * 剥不掉。所以这里两种取值都只传 `env`（如实说明，不假装支持）。
 */
function envFor(execOptions: ShellExecOptions | undefined): Record<string, string> | undefined {
	return execOptions?.env;
}

/** 拉 worker 侧整树，并对账删除：worker 的变更基线是空的，删除只能由「推出去的 − 拉回来的」得出 */
async function pulledChanges(worker: Worker, pushed: WasiFsChanges): Promise<WasiFsChanges> {
	const pulled = await requestChanges(worker);
	const alive = new Set<string>([...pulled.dirs, ...pulled.written.map((w) => w.path)]);
	return { deleted: pushed.written.map((w) => w.path).filter((p) => !alive.has(p)), dirs: pulled.dirs, written: pulled.written };
}

function requestChanges(worker: Worker): Promise<WasiFsChanges> {
	return new Promise<WasiFsChanges>((resolve, reject) => {
		const onMessage = (event: MessageEvent): void => {
			const data = event.data as ChangesResponse | undefined;
			if (data?.type !== 'pi-browser:changes') return;
			clearTimeout(timer);
			worker.removeEventListener('message', onMessage);
			resolve(data.changes);
		};
		const timer = setTimeout(() => {
			worker.removeEventListener('message', onMessage);
			reject(new Error(`worker 未在 ${PULL_TIMEOUT_MS}ms 内回传变更集`));
		}, PULL_TIMEOUT_MS);
		worker.addEventListener('message', onMessage);
		worker.postMessage({ type: PULL_CHANGES } satisfies PullChangesRequest);
	});
}
