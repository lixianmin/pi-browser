// src/shell/exec.ts —— busybox shell 后端：`Shell.exec` 映射到 wasi-sh 的 run()/spawn()（spec §3.2）。
//
// 两轨（线程模型）：
//   node/vitest（无 Worker 全局）→ `run({inline:true, fs: guestFs})`：主线程同步跑，run 边界同步见 sync-session。
//   浏览器（有 Worker 全局）→ `new Worker(workerUrl)` + `spawn()`：worker 内 `serve({fs})` 持有纯内存 store；
//     timeout/abort 走 `terminate()` 硬杀（inline 没有中断通道，只能做调用前 abort 检查）。
import { BACKGROUND_CONTEXT } from '../env/context.js';
import { ExecutionError, err, ok, toError } from '@earendil-works/pi-durable/env';
import { run, spawn } from 'wasi-sh';
import { isDir } from 'wasi-sh/fs';
import { createMountTable } from '../env/mount.js';
import { normalizePath } from '../env/path.js';
import { createMountSpill, OutputAccumulator } from './output-accumulator.js';
import { createHostCommandChannel, createHostCommandResponder, createHostCommandSharedBuffer, createInlineHostBuiltins, DEFAULT_HOST_COMMAND_TIMEOUT_MS, hostCommandNames, HOST_COMMAND_SAB_MESSAGE, } from './host-commands.js';
import { applyChanges, createSyncSession } from './sync-session.js';
import { logo } from '@needle/needle';
import { summarize } from '../logging.js';
import { PULL_CHANGES, PUSH_DIRS, bytesEqual, readMountTree, } from './wasi-fs.js';
/** 本包自带的 busybox.wasm（`scripts/build-busybox.sh` 的产物）；打包器需能解析该 asset URL */
const DEFAULT_WASM_URL = new URL('./busybox.wasm', import.meta.url);
/** 拉取 worker 变更集的等待上限：worker 死在回传前也不能把主线程挂住 */
const PULL_TIMEOUT_MS = 5000;
/** guest 初始 cwd 恒为 '/'（ash 的 pwd 实测），所以只有非 '/' 的 cwd 才需要前置 cd */
function withCwd(command, cwd) {
    return cwd === '/' ? command : `cd ${quoteForShell(cwd)} && ${command}`;
}
/** 单引号包裹 + 内部单引号转义（cwd 来自宿主/guest 输入，不能裸拼） */
function quoteForShell(value) {
    return `'${value.split("'").join("'\\''")}'`;
}
export function createBusyboxShell(store, options = {}) {
    /** 活着的 worker（浏览器路径）：cleanup 要能把它杀掉，否则页面刷新前一直挂着 */
    const liveWorkers = new Set();
    /** cleanup 之后置位：exec 入口先查它（Review Focus #5——cleanup 后再 exec 要响亮失败，不能挂住） */
    let closed = false;
    /**
     * 活着的那次 exec 的硬杀入口。cleanup 必须走它、而不是裸 `Worker.terminate()`：
     * wasi-sh 的 `session.exited` 只在 worker 的 exit 消息或 error 事件上 settle，硬 terminate 两者都不产生，
     * 于是 in-flight 的 `await session.exited` 会永久挂住。
     */
    // 活着的那次 exec 的硬杀入口，**按 exec 收集**而不是单槽：agent 并行调工具是常态，两次 exec
    // 并发时单槽会被第二次覆盖，cleanup / 回调失败就只能杀掉最后一次 —— 先发起的那次既没有 exit 消息
    // 也没有 error 事件（见上），`await session.exited` 永久挂住。
    const liveKills = new Set();
    // 注册表校验一次就够（与 applet/内建同名 → 抛错）；worker 消息与 builtins 的 lookup 都用这份名单
    const hostCommands = options.hostCommands ?? {};
    const hostNames = hostCommandNames(hostCommands);
    const wasm = options.wasm ?? DEFAULT_WASM_URL;
    const createOutputSink = (execOptions, context) => {
        let consumerHandler = () => { };
        const onOutput = execOptions?.onOutput;
        const spill = execOptions?.spill;
        const decoder = onOutput ? new TextDecoder() : undefined;
        let consumerError;
        /** 交付一段文本；消费者抛错 → 记 callback_error 并叫停本次 exec（stream 分片与收尾 flush 共用） */
        const emit = (text) => {
            if (text === '' || !onOutput)
                return;
            try {
                onOutput(text, context, { stream: 'stdout' });
            }
            catch (e) {
                consumerError = toError(e);
                consumerHandler();
            }
        };
        // spill 借 OutputAccumulator 的「阈值以下有界、越线时把已攒的 rawChunks 全量落盘」实现（spec D2：落点是挂载表）
        const accumulator = spill
            ? new OutputAccumulator({ maxLines: spill.afterLines, maxBytes: spill.afterBytes, tempFilePrefix: 'pi-shell' }, createMountSpill(createMountTable(store.mounts)))
            : undefined;
        return {
            deliver(bytes) {
                // 消费者抛错后不再交付（上游同款：`callbackError !== undefined` 即 return）
                if (consumerError)
                    return;
                if (decoder) {
                    // pi-durable 1.0.3 起 onOutput 第三个参数是 `ShellOutputInfo`（上游 Node 侧按流分流）。
                    // 本仓两条路（inline `run()` 与 worker `Session`）都只给一路合流后的字节，
                    // wasi-sh 不透出流名，所以恒报 'stdout'——调用方不能靠 `stream` 分流两路
                    //（合并投递是本仓既有的有意分叉，见 shell-exec 测试「stderr 与 stdout 合入同一路」）。
                    // 空串不交付（上游显式跳过）：分片边界落在多字节字符中间时解码器会吐出空串
                    emit(decoder.decode(bytes, { stream: true }));
                }
                accumulator?.append(bytes);
            },
            callbackFailure: () => consumerError,
            onConsumerError(handler) { consumerHandler = handler; },
            async finalize() {
                // 收尾 flush 也要走同一条 emit：裸调 onOutput 抛错会被 finalizeSink 误判成「spill 落盘失败」
                if (decoder && !consumerError)
                    emit(decoder.decode());
                if (!accumulator)
                    return undefined;
                accumulator.finish();
                const snapshot = accumulator.snapshot();
                // 先关 spill 文件再返回：调用方拿到 spillPath 后要能直接读全量
                await accumulator.closeTempFile();
                return snapshot.fullOutputPath;
            },
        };
    };
    /**
     * 收尾 sink 并吞掉 spill 异常：调用方契约是「`exec` 永远返回 `Result`」（不抛），而 spill 失败只是
     * 「全文没落成盘」——它不得把 shell 错误变成不透明 reject，也不得跳过 guest 的写落盘。
     */
    /**
     * 带 spill 路径的错误（pi-durable 1.0.2 的 `ExecutionError.spillPath` 字段就是为此存在）：
     * 命令被 timeout / abort / 回调失败杀掉时，输出**可能已经越阈值落盘**——那条路径不给调用方，
     * 落盘文件就成了不可达的孤儿（全量输出白丢）。所以每个错误分支都要把它带上。
     */
    const execError = (code, message, cause, spillPath) => {
        const e = new ExecutionError(code, message, cause);
        if (spillPath !== undefined)
            e.spillPath = spillPath;
        return e;
    };
    const finalizeSink = async (output) => {
        try {
            const spillPath = await output.finalize();
            return spillPath === undefined ? {} : { spillPath };
        }
        catch (e) {
            return { failure: new ExecutionError('unknown', `spill 落盘失败: ${toError(e).message}`, toError(e)) };
        }
    };
    const exec = async (command, execOptions, context) => {
        // 打点（spec 2026-10-23 §4）：shell 的收口。早退分支（cleanup 后、argv 不支持、非法 timeout）
        // 也在这一层被记到 —— 它们同样是「命令没跑起来」的事实。
        const startedAt = Date.now();
        const result = await runExec(command, execOptions, context);
        logo.info('shell exec', {
            command: summarize(typeof command === 'string' ? command : command.join(' ')),
            cwd: execOptions?.cwd,
            ok: result.ok,
            ...(result.ok ? { exitCode: result.value.exitCode } : { errorCode: result.error.code }),
            durationMs: Date.now() - startedAt,
        });
        return result;
    };
    /** exec 的真实实现（打点在外层 `exec`：见上面的注释） */
    const runExec = async (command, execOptions, context) => {
        if (closed)
            return err(new ExecutionError('shell_unavailable', 'shell 已 cleanup：不能再 exec'));
        // pi-durable 1.0.3 起 Shell.exec 接 argv 数组（不走 shell，`command[0]` 直跑）。本仓 wasi-sh / busybox
        // 不透出 argv（busybox applet 不是独立可执行文件），如实返 unknown 错。错误码与上游同走
        // `ExecutionError`（其 code 枚举无 `not_supported`），见 spec §10.2 P7。
        if (typeof command !== 'string') {
            return err(new ExecutionError('unknown', 'argv form not supported by wasi-sh backend'));
        }
        // 上游同款校验：0/负数/NaN 在 kill timer 与宿主命令等待里会被解释成不同值（立刻杀 vs 30s），
        // 两种解释都不是调用方要的，统一报错而不是猜。
        if (execOptions?.timeout !== undefined && (!Number.isFinite(execOptions.timeout) || execOptions.timeout <= 0)) {
            return err(new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'));
        }
        // 消费者回调抛错时由 sink 直接叫停活着的那次 exec（worker 路径需要杀子进程；上行传给 kill 的 'callback'
        // 不写进 killed，因收尾原因由返回值给出，是 callback_error）
        const output = createOutputSink(execOptions, context);
        // 默认 cwd 取挂载表的根（与 mount.ts 同一口径），不是「第一个注册的挂载」
        const cwd = normalizePath(execOptions?.cwd ?? createMountTable(store.mounts).cwd);
        return typeof Worker === 'undefined'
            ? await execInline(command, execOptions, context, output, cwd)
            : await execInWorker(command, execOptions, context, output, cwd);
    };
    /** inline 路径：run 边界的两个端点都在这里——seed（宿主树 → guest 缓存）与 pullAndApply（guest 变更 → 宿主 fs） */
    async function execInline(command, execOptions, context, output, cwd) {
        const session = createSyncSession(store);
        try {
            await session.seed();
        }
        catch (e) {
            return err(new ExecutionError('spawn_error', `无法读取工作区: ${toError(e).message}`, toError(e)));
        }
        const cwdError = checkCwd(session.guestFs.statSync, cwd);
        if (cwdError)
            return err(cwdError);
        // inline 无中断通道（run() 同步占满线程、没有 input/interrupt 通道）：只做调用前 abort 检查；
        // timeout 同理不生效（没有能触发的定时器）——语义豁免见 spec §4.5
        if (context.abortSignal?.aborted) {
            const pre = await finalizeSink(output);
            return err(execError('aborted', 'aborted', undefined, pre.spillPath));
        }
        let result;
        try {
            result = await run({
                command: withCwd(command, cwd),
                fs: session.guestFs,
                inline: true,
                wasm,
                env: envFor(execOptions),
                builtins: hostNames.length > 0 ? createInlineHostBuiltins(hostCommands) : undefined,
                onOutput: (bytes) => output.deliver(bytes),
            });
        }
        catch (e) {
            const failed = await finalizeSink(output);
            // wasm trap（run() 只吞 WasiExit）：worker 路径下 trap 是 exit 134 + 照常 pull，
            // 同一份写不该因为线程模型不同就丢掉。落盘失败不覆盖原始错误。
            try {
                await session.pullAndApply();
            }
            catch { /* 保留原始 spawn_error */ }
            return err(execError('spawn_error', toError(e).message, toError(e), failed.spillPath));
        }
        // 收尾放在落盘之前：即便 guest 的写没落盘，已产生的输出也交付出去
        const finalized = await finalizeSink(output);
        try {
            await session.pullAndApply();
        }
        catch (e) {
            // guest 的写没落盘：宁可把这次运行报成失败，也不返回「看起来成功」的结果
            return err(execError('unknown', toError(e).message, toError(e), finalized.spillPath));
        }
        if (finalized.failure)
            return err(execError('unknown', finalized.failure.message, undefined, finalized.spillPath));
        const consumerError = output.callbackFailure();
        if (consumerError)
            return err(execError('callback_error', consumerError.message, consumerError, finalized.spillPath));
        return ok({ exitCode: result.exitCode, ...(finalized.spillPath === undefined ? {} : { spillPath: finalized.spillPath }) });
    }
    async function execInWorker(command, execOptions, context, output, cwd) {
        if (options.workerUrl === undefined) {
            return err(new ExecutionError('shell_unavailable', '浏览器下的 busybox 需要 workerUrl：fs 不能跨 postMessage，必须由自建 worker 模块 serve({fs}) 注册'));
        }
        // 与 wasi-sh spawn() 同一道前置闸，但必须排在自建 SAB 之前：否则未开 COOP/COEP 的页面会先吃到
        // `new SharedArrayBuffer` 的 TypeError，被包成 spawn_error，掩盖真正可执行的修复指引。
        if (typeof SharedArrayBuffer === 'undefined'
            || (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === false)) {
            return err(new ExecutionError('shell_unavailable', 'worker 路径需要 SharedArrayBuffer（跨源隔离）：请给页面加 Cross-Origin-Opener-Policy: same-origin 与 Cross-Origin-Embedder-Policy: require-corp，或改用 inline 路径（run() 不需要跨源隔离）'));
        }
        // cwd 校验走宿主挂载表（worker 内的 store 此刻还没拿到树），口径与 inline 路径一致：不存在 → spawn_error
        const cwdInfo = await createMountTable(store.mounts).fileInfo(cwd, BACKGROUND_CONTEXT);
        if (!cwdInfo.ok || cwdInfo.value.kind !== 'directory')
            return err(new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}`));
        // 硬杀语义（spec §3.2）：被杀运行的**文件变更整体丢弃**（变更集没拉），已发布的输出保留
        let killed;
        let session;
        // spawn 还没返回时 session 是 undefined：此时 kill 只能叫醒竞速里等 spawn 的那一侧，
        // 否则 cleanup/abort 会等到 wasi-sh 的 30s readyTimeout 才以 spawn_error 收场。
        let abortSpawn;
        const kill = (why) => {
            // 'callback' 不写 killed：收尾原因由返回值给出（callback_error），不能被 abort 分支盖掉
            if (why !== 'callback')
                killed ??= why;
            if (session)
                session.terminate();
            else
                abortSpawn?.(new Error(why === 'timeout' ? 'timeout' : 'aborted'));
        };
        if (context.abortSignal?.aborted)
            return err(new ExecutionError('aborted', 'aborted')); // 调用前已中止：不启动 worker（与 inline 入口检查对齐）
        liveKills.add(kill); // 从这里起它算「活着的 exec」；finally 里摘掉
        // 消费者回调失败只杀**本次** exec；旧实现遍历 liveKills，一次回调抛错会把并发中的其它 exec 一起硬杀。
        output.onConsumerError(() => kill('callback'));
        const timer = execOptions?.timeout === undefined ? undefined : setTimeout(() => kill('timeout'), execOptions.timeout * 1000);
        const onAbort = () => kill('aborted');
        context.abortSignal?.addEventListener('abort', onAbort, { once: true });
        let worker;
        let channel;
        let serving;
        try {
            // Worker 构造会**同步**抛（跨源 workerUrl → SecurityError / CSP 拦截）：留在 try 外会让 exec
            // 直接 reject（违反「永远返回 Result」），并漏掉 timer 与 abort 监听的清理。
            worker = new Worker(options.workerUrl, { type: 'module' });
            liveWorkers.add(worker);
            // 宿主命令通道（S2.1 §3.2）：SAB 分配与本端应答循环都在这里；guest 侧的 builtin 在 worker 里等它
            // `??` 只挡 undefined：`timeout: 0` 会原样变成 0ms 宽限期，之后每次宿主命令应答都立即超时
            // （kill 定时器也是 0ms，整条命令立刻被杀）。0 在任何一种解释下都不是「零宽限期」的意思，
            // 落到缺省档。
            const timeoutSeconds = (execOptions?.timeout ?? DEFAULT_HOST_COMMAND_TIMEOUT_MS / 1000);
            const timeoutMs = (timeoutSeconds > 0 ? timeoutSeconds : DEFAULT_HOST_COMMAND_TIMEOUT_MS / 1000) * 1000;
            const sab = hostNames.length > 0 ? createHostCommandSharedBuffer() : undefined;
            channel = sab ? createHostCommandChannel(sab, { timeoutMs }) : undefined;
            if (sab && channel) {
                // 先投消息再 spawn：spawn 的启动消息在其后入队，worker 模块收到 SAB 时 shell 还没开始跑
                worker.postMessage({ type: HOST_COMMAND_SAB_MESSAGE, sab, timeoutMs, names: hostNames });
                serving = channel.hostSide.serve(createHostCommandResponder(store, hostCommands));
            }
            // 活着的 guest 收不到 postMessage，整树只能随启动消息（files）推给 worker；回传在 run 结束后拉
            const pushed = await readMountTree(store);
            const files = {};
            for (const { path, data } of pushed.written)
                files[path] = data;
            // 空目录不在 files 里（spawn 的 files 只表达文件）：单独投给 worker，且必须在启动消息之前（FIFO）。
            // 漏了它，guest 从一开始就「没有」这个目录，收尾对账会把宿主上的空目录当已删除递归删掉。
            if (pushed.dirs.length > 0)
                worker.postMessage({ type: PUSH_DIRS, dirs: pushed.dirs });
            // cleanup / abort 发生在 spawn 之前的窗口里：kill 没有 session 可杀，先把结果收尾。
            if (killed !== undefined) {
                const pre = await finalizeSink(output);
                return err(execError(killed, killed === 'timeout' ? `timeout:${execOptions?.timeout}` : 'aborted', undefined, pre.spillPath));
            }
            // spawn() 依赖 SharedArrayBuffer/crossOriginIsolated——浏览器部署需 COOP/COEP 响应头（README「浏览器部署」节）
            const spawning = spawn({ worker, command: withCwd(command, cwd), wasm, env: envFor(execOptions), files });
            // 输掉竞速后 spawn 仍会自己 reject（30s readyTimeout）：必须消化，不能变 unhandled
            spawning.catch(() => { });
            const spawnAborted = new Promise((_, reject) => { abortSpawn = reject; });
            try {
                session = await Promise.race([spawning, spawnAborted]);
            }
            finally {
                abortSpawn = undefined;
            }
            // 先接输出再决定生死：spawn 期间先到的输出也要交付（已发布输出保留是硬杀语义的一部分）
            session.onOutput((bytes) => output.deliver(bytes));
            // kill 恰好落在竞速已结算之后：补一刀（否则命令会跑完、只在最后被报成超时）
            if (killed !== undefined) {
                session.terminate();
            }
            else {
                // 本 shell 没有活 stdin（exec 从不写 stdin）：直接置 EOF，与 inline（run() 的固定输入）行为一致。
                // 与宿主命令通道无关：没有 hostCommands 时也必须置 EOF，否则 cat/read 会永久阻塞。
                // 管道（echo x | hostcmd）走 pipe fd、重定向（hostcmd < f）走 file fd，都不受这句影响
                session.end();
            }
            const exitCode = await session.exited;
            // 先停表再快照收尾原因：spill 落盘可能跨过 deadline，否则一个已经退出 0 的命令会被
            // 报成 timeout，且 applyChanges 不再执行（写全丢）。
            if (timer)
                clearTimeout(timer);
            const killReason = killed;
            const finalized = await finalizeSink(output);
            if (killReason === 'timeout')
                return err(execError('timeout', `timeout:${execOptions?.timeout}`, undefined, finalized.spillPath));
            if (killReason === 'aborted')
                return err(execError('aborted', 'aborted', undefined, finalized.spillPath));
            if (finalized.failure)
                return err(execError('unknown', finalized.failure.message, undefined, finalized.spillPath));
            const consumerError = output.callbackFailure();
            if (consumerError)
                return err(execError('callback_error', consumerError.message, consumerError, finalized.spillPath));
            await applyChanges(store, await pulledChanges(worker, pushed));
            return ok({ exitCode, ...(finalized.spillPath === undefined ? {} : { spillPath: finalized.spillPath }) });
        }
        catch (e) {
            const failed = await finalizeSink(output);
            // 竞速失败也可能是 kill 叫醒的：报回真实原因，而不是 spawn_error
            if (killed === 'timeout')
                return err(execError('timeout', `timeout:${execOptions?.timeout}`, undefined, failed.spillPath));
            if (killed === 'aborted')
                return err(execError('aborted', 'aborted', undefined, failed.spillPath));
            return err(execError('spawn_error', toError(e).message, toError(e), failed.spillPath));
        }
        finally {
            channel?.hostSide.stop();
            // 应答循环可能仍挂在处理器上（超时后处理器仍在后台跑、无法取消）——收尾**不阻塞**，
            // 否则宿主处理器永不 settle 会把 exec 一起挂住（终审 P1）；stop() 已保证循环不会再有新请求。
            void serving?.catch(() => { });
            if (timer)
                clearTimeout(timer);
            context.abortSignal?.removeEventListener('abort', onAbort);
            worker?.terminate(); // 一次 exec 一个 worker（与 run() 同构），杀掉不留悬挂线程
            if (worker)
                liveWorkers.delete(worker);
            liveKills.delete(kill);
        }
    }
    const cleanup = async () => {
        closed = true;
        // in-flight 的 exec 必须由 session.terminate() 收尾（见 killLiveExec 的注释）：先杀活的那次，
        // 再兜底 terminate worker。cleanup 后 exec 响亮失败（closed 闸），而不是静默挂住。
        for (const kill of liveKills)
            kill('aborted');
        for (const worker of liveWorkers)
            worker.terminate();
        liveWorkers.clear();
        liveKills.clear();
    };
    return { exec, cleanup };
}
/**
 * cwd 检查（spec §3.2：适配器 resolve 基准，不存在 → spawn_error）。
 * 顺带挡住「cwd 是个文件」——那同样起不了 shell。
 */
function checkCwd(statSync, cwd) {
    try {
        const stat = statSync(cwd);
        if (!isDir(stat.mode))
            return new ExecutionError('spawn_error', `Not a directory: ${cwd}`);
        return undefined;
    }
    catch {
        return new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}`);
    }
}
/**
 * env 映射：`run({env})`（wasi-sh 内部 mergeEnv：DEFAULT_ENV=PATH/HOME/TERM/LANG 之上叠宿主给的值）。
 * `inheritEnv:false` 的差异在浏览器里无法兑现——没有 process.env 可继承，而 DEFAULT_ENV 由 run() 无条件合并，
 * 剥不掉。所以这里两种取值都只传 `env`（如实说明，不假装支持）。
 */
function envFor(execOptions) {
    return execOptions?.env;
}
/**
 * 拉 worker 侧变更集，并对账删除：worker 的变更基线是空的，删除只能由「推出去的 − 拉回来的」得出。
 * **「拉回来的」必须是全量快照**（worker 的 PULL_CHANGES 回 `store.snapshot()`）——run 中间跑过宿主命令时
 * drain 基线已被推进，用 drain 回传会让差集为空，这里就会把推出去的整棵树当成已删除
 *（实测事故，回归测试 = test/worker-pull.test.ts）。
 */
async function pulledChanges(worker, pushed) {
    return reconcilePulled(pushed, await requestChanges(worker));
}
/**
 * 对账的纯函数部分（从 `pulledChanges` 拆出仅为可测：真 worker 在 node 下起不来）。
 * 删除集 = 推出去的 − 现在还在的；目录也要对账（guest `rm -rf`/`mv` 目录后宿主不留空壳），
 * 按深度降序删，保证到父目录时已空。
 */
export function reconcilePulled(pushed, pulled) {
    const pushedDirs = new Set(pushed.dirs);
    const pushedFiles = new Set(pushed.written.map((w) => w.path));
    const pulledDirs = new Set(pulled.dirs);
    const pulledFiles = new Set(pulled.written.map((w) => w.path));
    // 消失 + 类型变化（文件↔目录）。后者必须进 deleted：applyChanges 的契约是「先删旧节点再建新的」，
    // 否则 writeFile 打到旧目录 / createDir 打到旧文件，applyChanges 抛错、整轮其它写也不落盘。
    const gone = [...pushedFiles, ...pushed.dirs].filter((p) => !pulledDirs.has(p) && !pulledFiles.has(p));
    const kindChanged = [
        ...pushed.dirs.filter((p) => pulledFiles.has(p)),
        ...[...pushedFiles].filter((p) => pulledDirs.has(p)),
    ];
    const deleted = [...gone, ...kindChanged].sort((a, b) => b.split('/').length - a.split('/').length);
    // 只回写内容变了的文件：快照是全量，直接透传会把整棵工作区重写一遍（每条命令一次），
    // 顺带把所有文件的 mtime 刷成「刚刚」——find -newer / 增量构建 / git 索引全部失真。
    const before = new Map(pushed.written.map((w) => [w.path, w.data]));
    const written = pulled.written.filter((w) => {
        const prev = before.get(w.path);
        return prev === undefined || !bytesEqual(prev, w.data);
    });
    // 目录同理：只建新出现的（类型变化的那批不在 pushedDirs 里，会保留）
    const dirs = pulled.dirs.filter((p) => !pushedDirs.has(p));
    return { deleted, dirs, written };
}
function requestChanges(worker) {
    return new Promise((resolve, reject) => {
        const onMessage = (event) => {
            const data = event.data;
            if (data?.type !== 'pi-browser:changes')
                return;
            clearTimeout(timer);
            worker.removeEventListener('message', onMessage);
            resolve(data.changes);
        };
        const timer = setTimeout(() => {
            worker.removeEventListener('message', onMessage);
            reject(new Error(`worker 未在 ${PULL_TIMEOUT_MS}ms 内回传变更集`));
        }, PULL_TIMEOUT_MS);
        worker.addEventListener('message', onMessage);
        worker.postMessage({ type: PULL_CHANGES });
    });
}
