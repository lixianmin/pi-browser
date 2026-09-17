// src/shell/worker.ts —— 浏览器 worker 入口模块（wasi-sh worker 协议）。
//
// 宿主用法：`new Worker(workerUrl, { type: 'module' })`，workerUrl 指向本模块的打包产物；
// 然后由主线程 `spawn({ worker, ... })`。这里只做三件事：
//   ① 把**纯内存**适配器交给 `serve({ fs })`（fs 是活对象，不能结构化克隆进 worker，这是唯一入口）；
//   ② 响应主线程的变更集拉取（guest 跑完、worker 空闲时才收得到消息——运行中它钳住线程）；
//   ③ 装宿主命令 builtins（S2.1 §3.2）：主线程把 SAB 通道在**启动消息之前**投递进来，builtins 工厂
//      在启动消息到达时解析，那时 SAB 已经就位（同一 worker 的 postMessage 是 FIFO）。
//
// mounts 为空是刻意的：worker 内没有宿主权威树（IDB 只由主线程写）。初始树随 spawn 的 `files` 进来，
// 落盘由主线程在 run 边界拉回后写（单写者协议，spec §3.2）。
import { serve } from 'wasi-sh/worker';
import type { HostBuiltins } from 'wasi-sh';
import {
	createGuestHostBuiltins, createHostCommandChannel, HOST_COMMAND_SAB_MESSAGE,
	type HostCommandGuestSide, type HostCommandSabMessage,
} from './host-commands';
import { PULL_CHANGES, createWasiFileSystem, type ChangesResponse, type PullChangesRequest } from './wasi-fs';

const store = createWasiFileSystem({ mounts: [] });

/** 宿主命令通道（主线程在启动消息之前投递；未注册宿主命令时不存在） */
let hostCommands: { channel: HostCommandGuestSide; names: string[] } | undefined;

self.addEventListener('message', (event: MessageEvent<HostCommandSabMessage | PullChangesRequest>) => {
	const data = event.data;
	if (data?.type === HOST_COMMAND_SAB_MESSAGE) {
		hostCommands = { channel: createHostCommandChannel(data.sab, { timeoutMs: data.timeoutMs }).guestSide, names: data.names };
		return;
	}
	if (data?.type !== PULL_CHANGES) return;
	self.postMessage({ type: 'pi-browser:changes', changes: store.exportChanges() } satisfies ChangesResponse);
});

serve({
	fs: store,
	// 工厂而非现成对象：serve() 在启动消息到达时才解析它（那时 SAB 通道已装好）。
	// 返回 undefined 是「本 run 没注册宿主命令」——wasi-sh 的 hostBuiltins 把它当「没有 builtins」，
	// 与不传 builtins 等价（类型上工厂不接受 undefined，所以这里收窄一次）。
	builtins: (() => (hostCommands ? createGuestHostBuiltins(store, hostCommands.channel, hostCommands.names) : undefined)) as () => HostBuiltins,
});
