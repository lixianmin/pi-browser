// src/env/execution-env.ts —— 浏览器 ExecutionEnv（S1 主产物 + S2 exec 接线）。
// 装配默认挂载表（'/'→lightning-fs/IDB 持久面、'/tmp'→内存临时面），fs 各方法全部委托 MountTable；
// exec 默认装配 wasi-sh busybox（spec §3.2）：fs 之外的 exec 面在 src/shell/exec.ts。
import { ExecutionError, err } from '@earendil-works/pi-durable/env';
import { createMountTable } from './mount.js';
import { createBrowserFileSystem } from './backend-idb.js';
import { createMemoryFileSystem } from './backend-memory.js';
import { createBusyboxShell } from '../shell/exec.js';
import { RESERVED_COMMAND_NAMES } from '../shell/host-commands.js';
import { createDefaultHostCommands } from '../shell/host-commands/defaults.js';
export function createBrowserExecutionEnv(o = {}) {
    const mounts = o.mounts ?? [
        { prefix: '/', fs: createBrowserFileSystem({ dbName: o.dbName }) },
        { prefix: '/tmp', fs: createMemoryFileSystem() },
    ];
    const table = createMountTable(mounts);
    // 默认宿主命令（which/mount 等）叠在调用方给的之上；调用方可覆盖同名项。
    // which 需要知道「shell 能解析哪些名字」：applet/内建 ∪ 调用方注册的宿主命令。
    const userCommands = o.hostCommands ?? {};
    const resolvable = new Set([...RESERVED_COMMAND_NAMES, ...Object.keys(userCommands)]);
    const hostCommands = { ...createDefaultHostCommands(resolvable), ...userCommands };
    // 不预造 ShellBackend 接口（AGENTS §2）：有真实现就直接接线，接口等第二个真实实现出现时再提
    const shell = o.shell === false ? undefined : createBusyboxShell({ mounts }, { workerUrl: o.workerUrl, wasm: o.wasm, hostCommands });
    return {
        // fs 17 方法与 cleanup 全表委托（cleanup 的 best-effort 吞错在 MountTable 里，此处不重复实现）
        ...table,
        exec: shell
            ? shell.exec
            : async () => err(new ExecutionError('shell_unavailable', 'shell:false——exec 占位，未装配 backend')),
        // cleanup 要覆盖两边：光放掉 fs 不杀 worker 会留下悬挂线程
        cleanup: async (context) => {
            await table.cleanup(context);
            await shell?.cleanup(context);
        },
    };
}
