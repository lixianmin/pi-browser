// src/env/execution-env.ts —— 浏览器 ExecutionEnv（S1 主产物 + S2 exec 接线）。
// 装配默认挂载表（'/'→lightning-fs/IDB 持久面、'/tmp'→内存临时面），fs 各方法全部委托 MountTable；
// exec 默认装配 wasi-sh busybox（spec §3.2）：fs 之外的 exec 面在 src/shell/exec.ts。
import { ExecutionError, err, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { createMountTable } from './mount';
import type { MountEntry } from './types';
import { createBrowserFileSystem } from './backend-idb';
import { createMemoryFileSystem } from './backend-memory';
import { createBusyboxShell } from '../shell/exec';

export interface BrowserExecutionEnvOptions {
	/** IndexedDB 库名（默认挂载 '/' 用）；默认 'spice-sessions'（沿用以减少漂移面，见 BrowserFileSystemOptions） */
	dbName?: string;
	/** 覆盖默认挂载表（宿主注册其它 backend 的缝；本库不内置 backend-fsa） */
	mounts?: MountEntry[];
	/** shell backend：默认 'busybox'（wasi-sh busybox ash）；`false` 保持 S1 的占位（exec 恒 shell_unavailable） */
	shell?: 'busybox' | false;
	/** 浏览器下的 worker 模块 URL（打包器产物）；node/vitest 走 inline 路径，不需要（见 BusyboxShellOptions） */
	workerUrl?: URL | string;
}

export function createBrowserExecutionEnv(o: BrowserExecutionEnvOptions = {}): ExecutionEnv {
	const mounts = o.mounts ?? [
		{ prefix: '/', fs: createBrowserFileSystem({ dbName: o.dbName }) },
		{ prefix: '/tmp', fs: createMemoryFileSystem() },
	];
	const table = createMountTable(mounts);
	// 不预造 ShellBackend 接口（AGENTS §2）：有真实现就直接接线，接口等第二个真实实现出现时再提
	const shell = o.shell === false ? undefined : createBusyboxShell({ mounts }, { workerUrl: o.workerUrl });
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
