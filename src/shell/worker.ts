// src/shell/worker.ts —— 浏览器 worker 入口模块（wasi-sh worker 协议）。
//
// 宿主用法：`new Worker(workerUrl, { type: 'module' })`，workerUrl 指向本模块的打包产物；
// 然后由主线程 `spawn({ worker, ... })`。这里只做两件事：
//   ① 把**纯内存**适配器交给 `serve({ fs })`（fs 是活对象，不能结构化克隆进 worker，这是唯一入口）；
//   ② 响应主线程的变更集拉取（guest 跑完、worker 空闲时才收得到消息——运行中它钳住线程）。
//
// mounts 为空是刻意的：worker 内没有宿主权威树（IDB 只由主线程写）。初始树随 spawn 的 `files` 进来，
// 落盘由主线程在 run 边界拉回后写（单写者协议，spec §3.2）。
import { serve } from 'wasi-sh/worker';
import { PULL_CHANGES, createWasiFileSystem, type ChangesResponse, type PullChangesRequest } from './wasi-fs';

const store = createWasiFileSystem({ mounts: [] });
serve({ fs: store });

self.addEventListener('message', (event: MessageEvent<PullChangesRequest>) => {
	if (event.data?.type !== PULL_CHANGES) return;
	self.postMessage({ type: 'pi-browser:changes', changes: store.exportChanges() } satisfies ChangesResponse);
});
