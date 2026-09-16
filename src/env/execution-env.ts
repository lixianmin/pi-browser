// src/env/execution-env.ts —— 浏览器 ExecutionEnv（S1 主产物）。
// 装配默认挂载表（'/'→lightning-fs/IDB 持久面、'/tmp'→内存临时面），fs 各方法全部委托 MountTable；
// exec 在 S1 没有实现，恒返回 `shell_unavailable`（上游认可的 ExecutionErrorCode，不是 hack）。
import { ExecutionError, err, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { createMountTable, type MountEntry } from './mount';
import { createBrowserFileSystem } from './backend-idb';
import { createMemoryFileSystem } from './backend-memory';

export interface BrowserExecutionEnvOptions {
	/** IndexedDB 库名（默认挂载 '/' 用）；默认 'spice-sessions'（沿用以减少漂移面，见 BrowserFileSystemOptions） */
	dbName?: string;
	/** 覆盖默认挂载表（宿主注册其它 backend 的缝；本库不内置 backend-fsa） */
	mounts?: MountEntry[];
}

export function createBrowserExecutionEnv(o: BrowserExecutionEnvOptions = {}): ExecutionEnv {
	const table = createMountTable(o.mounts ?? [
		{ prefix: '/', fs: createBrowserFileSystem({ dbName: o.dbName }) },
		{ prefix: '/tmp', fs: createMemoryFileSystem() },
	]);
	return {
		// fs 17 方法与 cleanup 全表委托（cleanup 的 best-effort 吞错在 MountTable 里，此处不重复实现）
		...table,
		// 不预造 ShellBackend 接口（AGENTS §2）：唯一实现的 interface 没有意义，S2 的三个候选 backend
		// 形状差异大（受限 ash / TS shell 子集 / quickjs），缝的形状等第二个真实实现出现时再提。
		exec: async () => err(new ExecutionError('shell_unavailable', '浏览器环境无 shell（S2 提供 backend）')),
	};
}
