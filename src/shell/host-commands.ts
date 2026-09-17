// src/shell/host-commands.ts —— 宿主命令 seam（S2.1 spec §3）：宿主动态声明新的 shell 命令
// （名字 → JS 处理器），guest 像 applet 一样调用它们（可被管道/重定向/$()/if 组合）。
// **seam 与具体命令无关**：本文件不认任何命令语义（第一个消费者是 spice 的版本控制桥，但这里不依赖它）。
//
// 两条路径（guest 运行中独占线程 ⇒ 能力不同）：
//   inline（node/vitest，无 Worker）：builtin 与 guest 同线程同栈帧，**只支持同步纯处理器**——
//     没有第二个线程可停靠，所以异步处理器、以及任何 FS 访问（读或写）都必须走 worker 路径。
//   worker（浏览器）：builtin 仍是同步的，但请求经 SharedArrayBuffer + futex 停靠到主线程，
//     主线程跑异步处理器（这才是这个 seam 的价值：宿主可以用任意异步库），并按 §3.3 对账 FS：
//     调用前把 guest 变更集落进权威 store，处理器直接读写权威 store，返回后把 store 的净变化推回 guest 缓存。
import { toError } from '@earendil-works/pi-agent-core';
import { atomics } from './atomics';
import type { HostBuiltins, BuiltinContext } from 'wasi-sh';
import type { BrowserFileSystem } from '../env/types';
import { createMountTable } from '../env/mount';
import { applyChanges, flushMounts } from './sync-session';
import { readMountTree, type ShellFsStore, type WasiFileSystem, type WasiFsChanges } from './wasi-fs';

export interface HostCommandRequest {
	/** 命令名（注册时的 key；argv[0]） */
	name: string;
	/** argv[1..]（不含命令名） */
	args: string[];
	/** guest 侧的当前工作目录 */
	cwd: string;
	/** guest 从 fd 0 读到的内容；无输入时为 undefined（详见 README「宿主命令」） */
	stdin?: string;
	/** guest 的实时环境（exports + 本命令的 VAR=x 前缀） */
	env?: Record<string, string>;
}

export interface HostCommandResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
}

/** 处理器在**主线程**执行，允许 async（inline 路径例外：见 createInlineHostBuiltins） */
export type HostCommandHandler = (request: HostCommandRequest, fs: BrowserFileSystem) => Promise<HostCommandResult> | HostCommandResult;

/** 名字 → 处理器（注册表；`createBrowserExecutionEnv({ hostCommands })`） */
export type HostCommandRegistry = Record<string, HostCommandHandler>;

/**
 * 保留名：busybox applet 与 ash 内建。ash 的解析顺序是 函数 → shell 内建 → applet → 宿主内建 → PATH，
 * 所以同名宿主命令**永远不会被调用**（被 applet 静默抢走）——必须在注册时拒绝，而不是让调用方以为注册成功了。
 *
 * 来源：锁定版本 wasi-sh 0.11.0 的 busybox 1.38.0 构建（`busybox.config` 里 `CONFIG_*=y` 的 applet +
 * README「The toolbox」+ ash 内建名）。升级 wasi-sh 时需重新对账：漏掉的名字只会被静默抢走，
 * 多出来的名字只是误拒（保守方向）。
 */
const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
	// applet
	'ash', 'awk', 'basename', 'cat', 'cksum', 'cp', 'crc32', 'cut', 'date', 'dirname', 'du', 'echo', 'env',
	'expr', 'false', 'find', 'fold', 'getopt', 'grep', 'head', 'hexdump', 'ls', 'md5sum', 'mkdir', 'mktemp', 'mv',
	'nproc', 'paste', 'printenv', 'printf', 'pwd', 'realpath', 'rm', 'rmdir', 'sed', 'seq', 'sh', 'sha1sum',
	'sha256sum', 'sort', 'stat', 'stty', 'tac', 'tail', 'test', 'touch', 'tr', 'true', 'uname', 'uniq', 'unlink',
	'wc', 'xargs', 'xxd',
	// ash 内建
	'.', ':', '[', 'alias', 'bg', 'break', 'cd', 'chdir', 'command', 'continue', 'eval', 'exec', 'exit', 'export',
	'fc', 'fg', 'getopts', 'hash', 'jobs', 'kill', 'local', 'read', 'readonly', 'return', 'set', 'shift', 'times',
	'trap', 'type', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);

/**
 * 校验注册表并返回名字清单（供 worker 消息与 builtins 的 `lookup`）。
 * 与 applet/内建同名 → 抛错（不静默覆盖内建，也不静默失效）。
 */
export function hostCommandNames(registry: HostCommandRegistry): string[] {
	const names = Object.keys(registry);
	for (const name of names) {
		if (!RESERVED_COMMAND_NAMES.has(name)) continue;
		throw new Error(`宿主命令 "${name}" 与 shell 内建/applet 同名：ash 的解析顺序在你前面，注册了也不会被调用`);
	}
	return names;
}

// ——————————————————————————— SAB 协议（双端） ———————————————————————————

/**
 * 响应方向的字节上限（SAB 定长，两个方向各一份）。8MB 取自 spike v3 的实测形状；
 * 超出的应答按阶段截断并在 stderr 追加说明（见 fitResponse），超过上限的**变更集**则无法回传。
 */
const DEFAULT_CAPACITY = 8 * 1024 * 1024;
/** guest 侧等待宿主应答的上限；exec 路径传 exec 自己的 timeout（未设时用这个值） */
export const DEFAULT_HOST_COMMAND_TIMEOUT_MS = 30_000;
const CTRL_SLOTS = 8;
const CTRL_BYTES = CTRL_SLOTS * Int32Array.BYTES_PER_ELEMENT;
/** ctrl 槽位：0=请求序号（guest 递增）1=已应答序号 2=请求字节数 3=应答字节数（其余留白） */
const SLOT_REQUEST_SEQ = 0;
const SLOT_ANSWER_SEQ = 1;
const SLOT_REQUEST_LENGTH = 2;
const SLOT_RESPONSE_LENGTH = 3;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * 从 SAB 视图解码前**必须拷成非共享视图**：Chrome 的 `TextDecoder.decode()` 拒绝 SharedArrayBuffer 视图
 * （抛 "The provided ArrayBufferView value must not be shared"）。Node 不抛——所以本仓单测全绿、
 * 浏览器里表现为「宿主命令全部 30s 超时」（spice 侧首个真浏览器消费者实测暴露，回归测试见
 * test/host-commands.test.ts 的「decode 不得直接吃 SAB 视图」）。
 */
const decodeShared = (bytes: Uint8Array, length: number): string => DEC.decode(new Uint8Array(bytes.subarray(0, length)));

/** thenable 判定：inline 路径靠它把「异步处理器」和「同步结果」分开（返回值类型上是联合） */
const isThenable = (value: unknown): value is Promise<unknown> => typeof (value as { then?: unknown } | undefined)?.then === 'function';

/** 变更集在 SAB 里的 JSON 形态：文件内容按字节数组走（spike 的 walkTree 同法，避免 base64 依赖） */
interface WireChanges {
	deleted: string[];
	dirs: string[];
	written: { path: string; data: number[] }[];
}

export interface HostCommandExchangeRequest extends HostCommandRequest {
	/** guest 侧自上次对账以来的变更集（drain 出来的） */
	changes: WasiFsChanges;
}

export interface HostCommandExchangeResult extends HostCommandResult {
	/** 宿主侧写回 guest 的净变化（处理器引起的） */
	changes: WasiFsChanges;
}

export interface HostCommandGuestSide {
	/** 写入请求并通知宿主；返回本次请求的序号（非阻塞） */
	send(request: HostCommandExchangeRequest): number;
	/** 阻塞等待该序号被应答（worker 内同步 builtin 唯一的等待方式）；超时抛错 */
	wait(seq: number): void;
	/** 读取应答；该序号还没被应答时抛错 */
	read(seq: number): HostCommandExchangeResult;
	/** send + wait + read（worker 内 builtin 用的整条同步路径） */
	call(request: HostCommandExchangeRequest): HostCommandExchangeResult;
}

export type HostCommandResponder = (request: HostCommandRequest, changes: WasiFsChanges) => Promise<HostCommandExchangeResult>;

export interface HostCommandHostSide {
	/** 等待并应答一次请求；返回 false 表示已 stop（单次交换，与 serve 共用同一份应答逻辑） */
	respondOnce(responder: HostCommandResponder): Promise<boolean>;
	/** 一直应答到 stop() */
	serve(responder: HostCommandResponder): Promise<void>;
	/** 停止应答循环（同时递增请求序号唤醒等待中的宿主侧，不阻塞调用方） */
	stop(): void;
}

export interface HostCommandChannel {
	hostSide: HostCommandHostSide;
	guestSide: HostCommandGuestSide;
}

/** 主线程 → worker 的通道投递消息（必须早于 spawn 的启动消息：同一 worker 的 postMessage 是 FIFO） */
export const HOST_COMMAND_SAB_MESSAGE = 'pi-browser:host-commands';

export interface HostCommandSabMessage {
	type: typeof HOST_COMMAND_SAB_MESSAGE;
	sab: SharedArrayBuffer;
	names: string[];
	timeoutMs: number;
}

/** 按容量分配 SAB（容量由 SAB 长度推出，两侧不会各说各的） */
export function createHostCommandSharedBuffer(options: { capacity?: number } = {}): SharedArrayBuffer {
	const capacity = options.capacity ?? DEFAULT_CAPACITY;
	return new SharedArrayBuffer(CTRL_BYTES + 2 * capacity);
}

/**
 * 双端通道（S2.1 §3.2 的 futex 形状，spike v3 已验证）：
 * guest 写请求 → 递增请求序号 + notify → 宿主侧 `Atomics.waitAsync` 轮询（**事件循环保持自由**，
 * 所以能跑异步处理器）→ 写应答 + 递增已应答序号 + notify → guest 侧 `Atomics.wait` 醒来。
 * 两端都不依赖真 Worker，可以同线程单测（guest 的阻塞等待只在超时那条用例里跑）。
 */
/**
 * 宿主处理器是任意用户代码（spec 明说可用任意异步库）——永不 settle 时不能让应答循环
 * 与 exec 一起卡死（终审 P1）：超时按协议层失败处理，回 exitCode=1 + stderr 摘要。
 */
async function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number, name: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => { reject(new Error(`宿主命令 ${name} 处理超过 ${timeoutMs}ms 未返回`)); }, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function createHostCommandChannel(sab: SharedArrayBuffer, options: { timeoutMs?: number } = {}): HostCommandChannel {
	const payloadBytes = sab.byteLength - CTRL_BYTES;
	if (payloadBytes < 2 || payloadBytes % 2 !== 0) {
		throw new Error(`宿主命令 SAB 布局不对：需要 32 + 2*capacity 字节（用 createHostCommandSharedBuffer 分配），实际 ${sab.byteLength}`);
	}
	const capacity = payloadBytes / 2;
	const timeoutMs = options.timeoutMs ?? DEFAULT_HOST_COMMAND_TIMEOUT_MS;
	const ctrl = new Int32Array(sab, 0, CTRL_SLOTS);
	const requestBytes = new Uint8Array(sab, CTRL_BYTES, capacity);
	const responseBytes = new Uint8Array(sab, CTRL_BYTES + capacity, capacity);

	const encodeChanges = (changes: WasiFsChanges): WireChanges => ({
		deleted: changes.deleted,
		dirs: changes.dirs,
		written: changes.written.map(({ path, data }) => ({ path, data: Array.from(data) })),
	});
	const decodeChanges = (wire: WireChanges): WasiFsChanges => ({
		deleted: wire.deleted,
		dirs: wire.dirs,
		written: wire.written.map(({ path, data }) => ({ path, data: new Uint8Array(data) })),
	});
	const emptyChanges = (): WireChanges => ({ deleted: [], dirs: [], written: [] });

	/** 应答超过定长 → 阶段截断：stderr 的诊断价值优先（先砍 stdout），两者都放不下时只留说明 */
	const fitResponse = (result: HostCommandResult, changes: WireChanges): { exitCode: number; stdout?: string; stderr?: string; changes: WireChanges } => {
		const encodedLength = (r: HostCommandResult & { changes: WireChanges }): number => ENC.encode(JSON.stringify(r)).length;
		const cut = (text: string, maxBytes: number): string => DEC.decode(ENC.encode(text).subarray(0, Math.max(0, maxBytes)));
		let response = { ...result, changes };
		if (encodedLength(response) <= capacity) return response;
		const note = `\n[宿主命令输出被截断：应答超过 ${capacity} 字节上限]\n`;
		let stderr = result.stderr ?? '';
		if (ENC.encode(stderr).length + ENC.encode(note).length > capacity) {
			stderr = cut(stderr, capacity - ENC.encode(note).length);
		}
		response = { ...response, stdout: '', stderr: stderr + note };
		const room = capacity - encodedLength(response);
		if (room < 0) throw new Error(`宿主命令应答的变更集超过 ${capacity} 字节上限，无法回传`);
		let stdout = cut(result.stdout ?? '', room);
		// JSON 转义会让字节数放大：还超就折半收敛，宁可少一点也不能发出坏 JSON（guest 那边解不开）
		while (stdout !== '' && encodedLength({ ...response, stdout }) > capacity) stdout = cut(stdout, Math.floor(ENC.encode(stdout).length / 2));
		return { ...response, stdout: stdout === '' ? undefined : stdout };
	};

	// —— guest 侧（worker 内，同步）——
	const send = (request: HostCommandExchangeRequest): number => {
		const payload = ENC.encode(JSON.stringify({ ...request, changes: encodeChanges(request.changes) }));
		if (payload.length > capacity) throw new Error(`宿主命令 "${request.name}" 的请求超过 ${capacity} 字节上限`);
		requestBytes.set(payload, 0);
		Atomics.store(ctrl, SLOT_REQUEST_LENGTH, payload.length);
		// 先写载荷再递增序号：宿主侧看到新序号时载荷已经可见
		const seq = (Atomics.add(ctrl, SLOT_REQUEST_SEQ, 1) + 1) | 0;
		Atomics.notify(ctrl, SLOT_REQUEST_SEQ);
		return seq;
	};
	const wait = (seq: number): void => {
		const deadline = Date.now() + timeoutMs;
		let answered = Atomics.load(ctrl, SLOT_ANSWER_SEQ);
		while (answered !== seq) {
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`宿主命令等待超过 ${timeoutMs}ms 未应答（timeout）`);
			Atomics.wait(ctrl, SLOT_ANSWER_SEQ, answered, left);
			answered = Atomics.load(ctrl, SLOT_ANSWER_SEQ);
		}
	};
	const read = (seq: number): HostCommandExchangeResult => {
		if (Atomics.load(ctrl, SLOT_ANSWER_SEQ) !== seq) throw new Error(`宿主命令应答未就绪（seq ${seq}）`);
		const decoded = JSON.parse(decodeShared(responseBytes, Atomics.load(ctrl, SLOT_RESPONSE_LENGTH))) as HostCommandResult & { changes: WireChanges };
		return { exitCode: decoded.exitCode, stdout: decoded.stdout, stderr: decoded.stderr, changes: decodeChanges(decoded.changes) };
	};

	// —— 宿主侧（主线程，异步）——
	let stopped = false;
	/** 请求序号是单调计数器，host 侧记住处理到哪；stop() 也靠递增它来唤醒等待 */
	let served = Atomics.load(ctrl, SLOT_REQUEST_SEQ);
	const waitForRequest = async (): Promise<number | undefined> => {
		for (;;) {
			const current = Atomics.load(ctrl, SLOT_REQUEST_SEQ);
			if (stopped) return undefined;
			if (current !== served) return current;
			await atomics.waitAsync(ctrl, SLOT_REQUEST_SEQ, served).value;
		}
	};
	const respondOnce = async (responder: HostCommandResponder): Promise<boolean> => {
		const seq = await waitForRequest();
		if (seq === undefined) return false;
		served = seq;
		// 载荷里 changes 是 JSON 形态（字节数组），解出来换成领域类型再交给 responder
		const { changes: guestChanges, ...command } = JSON.parse(
			decodeShared(requestBytes, Atomics.load(ctrl, SLOT_REQUEST_LENGTH)),
		) as HostCommandRequest & { changes: WireChanges };
		let response: { exitCode: number; stdout?: string; stderr?: string; changes: WireChanges };
		try {
			const exchange = await raceWithTimeout(responder(command, decodeChanges(guestChanges)), timeoutMs, command.name);
			response = fitResponse({ exitCode: exchange.exitCode, stdout: exchange.stdout, stderr: exchange.stderr }, encodeChanges(exchange.changes));
		} catch (e) {
			// 协议层失败（处理器自己的异常已在 responder 里变成 exitCode=1）：也不能让 guest 挂死
			response = { exitCode: 1, stderr: `${command.name}: ${toError(e).message}\n`, changes: emptyChanges() };
		}
		const payload = ENC.encode(JSON.stringify(response));
		responseBytes.set(payload, 0);
		Atomics.store(ctrl, SLOT_RESPONSE_LENGTH, payload.length);
		Atomics.store(ctrl, SLOT_ANSWER_SEQ, seq);
		Atomics.notify(ctrl, SLOT_ANSWER_SEQ);
		return true;
	};

	const hostSide: HostCommandHostSide = {
		respondOnce,
		serve: async (responder) => { while (await respondOnce(responder)) { /* 一条一条应答直到 stop() */ } },
		stop: () => {
			stopped = true;
			// 递增序号再唤醒：等待中的 waitAsync 会因序号变化立刻返回，不会永远停在那里
			Atomics.add(ctrl, SLOT_REQUEST_SEQ, 1);
			Atomics.notify(ctrl, SLOT_REQUEST_SEQ);
		},
	};
	const guestSide: HostCommandGuestSide = {
		send,
		wait,
		read,
		call: (request) => {
			const seq = send(request);
			wait(seq);
			return read(seq);
		},
	};
	return { hostSide, guestSide };
}

// ——————————————————————————— 宿主侧：对账 + 派发（S2.1 §3.3） ———————————————————————————

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** 处理器拿到的 fs：权威 store 的异步视图（异步正是这个 seam 的价值） */
function hostFileSystem(store: ShellFsStore): BrowserFileSystem {
	const table = createMountTable(store.mounts);
	return { ...table, flush: () => flushMounts(store) };
}

/** 两份整树快照的净变化（`readMountTree` 的 `deleted` 恒空，删除由「前有后无」得出） */
function diffTree(before: WasiFsChanges, after: WasiFsChanges): WasiFsChanges {
	const beforeFiles = new Map(before.written.map(({ path, data }) => [path, data]));
	const afterFiles = new Map(after.written.map(({ path, data }) => [path, data]));
	const written = after.written.filter(({ path, data }) => {
		const previous = beforeFiles.get(path);
		return previous === undefined || !sameBytes(previous, data);
	});
	const dirs = after.dirs.filter((path) => !before.dirs.includes(path));
	const gone = [...beforeFiles.keys(), ...before.dirs].filter((path) => !afterFiles.has(path) && !after.dirs.includes(path));
	// 类型变了（文件↔目录）的路径也在 deleted 里：契约要求先删旧节点再建新节点，否则会在文件上建目录
	const kindChanged = [
		...[...beforeFiles.keys()].filter((path) => after.dirs.includes(path)),
		...before.dirs.filter((path) => afterFiles.has(path)),
	];
	// 目录只报最上层：删掉的目录其子项也一起不见了，逐条报只是噪音（应用顺序要求父先于子）
	const candidates = [...gone, ...kindChanged];
	const deleted = candidates.filter((path) => !candidates.some((other) => other !== path && path.startsWith(`${other}/`)));
	return { deleted: deleted.sort(), dirs: dirs.sort(), written };
}

/**
 * 主机侧（worker 路径的主线程）单条请求的应答：① guest 变更落权威 store ② 处理器读写权威 store
 * ③ 把 store 的净变化算出来回传。处理器抛错 → exitCode=1 + stderr 摘要（不让 worker 挂死）。
 */
export function createHostCommandResponder(store: ShellFsStore, handlers: HostCommandRegistry): HostCommandResponder {
	return async (request, changes) => {
		await applyChanges(store, changes);            // ① 调用前：guest 变更集 → 权威 store（含 flush）
		const before = await readMountTree(store);     // ② 处理器执行前的快照（净变化的基准）
		const handler = handlers[request.name];
		let result: HostCommandResult;
		try {
			result = handler
				? await handler(request, hostFileSystem(store))
				: { exitCode: 127, stderr: `${request.name}: not found\n` };
		} catch (e) {
			result = { exitCode: 1, stderr: `${request.name}: ${toError(e).message}\n` };
		}
		const after = await readMountTree(store);
		await flushMounts(store);                      // ③ 返回后：处理器写的也要落盘
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, changes: diffTree(before, after) };
	};
}

// ——————————————————————————— guest 侧 builtins ———————————————————————————

/** guest 从 fd 0 读输入（管道/文件重定向即时可读；无活 stdin 时是 EOF） */
function readStdin(ctx: BuiltinContext): string | undefined {
	const bytes = ctx.stdin();
	return bytes.length > 0 ? DEC.decode(bytes) : undefined;
}

/**
 * worker 侧的宿主命令 builtins（同步）：每次调用把 guest 变更集 drain 出去发给主线程，
 * 停靠等应答，再把宿主侧的净变化落回缓存（所以 guest 立刻能读到处理器的写）。
 */
export function createGuestHostBuiltins(guestFs: WasiFileSystem, channel: HostCommandGuestSide, names: readonly string[]): HostBuiltins {
	const registered = new Set(names);
	return {
		lookup: (name) => registered.has(name),
		run: (ctx) => {
			const name = ctx.argv[0] ?? '';
			const response = channel.call({
				name,
				args: ctx.argv.slice(1),
				cwd: ctx.cwd,
				stdin: readStdin(ctx),
				env: ctx.env,
				changes: guestFs.exportChanges(),
			});
			guestFs.applyChanges(response.changes);
			if (response.stdout) ctx.stdout(response.stdout);
			if (response.stderr) ctx.stderr(response.stderr);
			return response.exitCode;
		},
	};
}

/**
 * inline 路径的处理器 fs：本路径没有第二个线程，异步 FS 调用永远拿不到结果（guest 是同步帧，
 * 微任务不会跑），所以**一律抛错**指向 worker 路径——宁可明确失败，也不给半个能用（能写不能读）的 FS。
 */
function inlineUnsupportedFileSystem(name: string): BrowserFileSystem {
	const fail = (op: string): never => {
		throw new Error(`宿主命令 "${name}" 访问了 fs.${op}：inline 路径没有第二个线程可停靠，有 FS 效果的宿主命令必须走 worker 路径`);
	};
	return {
		cwd: '/',
		absolutePath: () => fail('absolutePath'),
		joinPath: () => fail('joinPath'),
		readTextFile: () => fail('readTextFile'),
		readTextLines: () => fail('readTextLines'),
		readBinaryFile: () => fail('readBinaryFile'),
		writeFile: () => fail('writeFile'),
		appendFile: () => fail('appendFile'),
		renameFile: () => fail('renameFile'),
		fileInfo: () => fail('fileInfo'),
		listDir: () => fail('listDir'),
		canonicalPath: () => fail('canonicalPath'),
		exists: () => fail('exists'),
		createDir: () => fail('createDir'),
		remove: () => fail('remove'),
		createTempDir: () => fail('createTempDir'),
		createTempFile: () => fail('createTempFile'),
		cleanup: () => fail('cleanup'),
		flush: () => fail('flush'),
	};
}

/**
 * inline 路径的宿主命令 builtins：直接同步调处理器（无停靠）。只支持**同步纯处理器**——
 * 异步处理器（返回 thenable）在这里明确抛错，因为 guest 帧里没人能 await 它。
 */
export function createInlineHostBuiltins(handlers: HostCommandRegistry): HostBuiltins {
	return {
		lookup: (name) => Object.hasOwn(handlers, name),
		run: (ctx) => {
			const name = ctx.argv[0] ?? '';
			const handler = handlers[name];
			if (!handler) {
				ctx.stderr(`${name}: not found\n`);
				return 127;
			}
			const result = handler(
				{ name, args: ctx.argv.slice(1), cwd: ctx.cwd, stdin: readStdin(ctx), env: ctx.env },
				inlineUnsupportedFileSystem(name),
			);
			if (isThenable(result)) {
				void result.catch(() => { /* 没人要的失败：抛错本身已经让这条命令失败 */ });
				throw new Error(`宿主命令 "${name}" 返回 Promise：inline 路径没有第二个线程可停靠，异步处理器必须走 worker 路径`);
			}
			if (result.stdout) ctx.stdout(result.stdout);
			if (result.stderr) ctx.stderr(result.stderr);
			return result.exitCode;
		},
	};
}
