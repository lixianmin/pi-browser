// src/shell/sync-session.ts —— run 边界的单写者同步（spec §3.2）。
//
// 协议（**运行中不同步**：一个活会话就是单个同步 `_start()` 帧，postMessage/事件循环都不达）：
//   ① run 前 seed()：宿主权威树 → guest 同步缓存
//   ② run：guest 只在缓存上读写（worker 内的 store 是纯内存临时面）
//   ③ run 后 pullAndApply()：变更集 → 宿主 fs → flush()
// 单写者由此成立：IDB 只由主线程在第 ③ 步写，guest 从不直接碰持久面。
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createMountTable } from '../env/mount';
import { createWasiFileSystem, type ShellFsStore, type WasiFsChanges, type WasiFileSystem } from './wasi-fs';

export interface ShellSyncSession {
	/** 交给 wasi-sh `run()`/`spawn()` 的 store */
	guestFs: WasiFileSystem;
	/** run 前：挂载树 → guest 缓存 */
	seed(): Promise<void>;
	/** run 后：guest 变更集 → 挂载树 + flush */
	pullAndApply(): Promise<void>;
}

export function createSyncSession(store: ShellFsStore): ShellSyncSession {
	const guestFs = createWasiFileSystem(store);
	return {
		guestFs,
		// seed 的实现归适配器（挂载树就是它的注入面）；session 只加协议：何时载入、何时回写
		seed: () => guestFs.seed(),
		pullAndApply: async () => { await applyChanges(store, guestFs.exportChanges()); },
	};
}

/**
 * 把变更集写回宿主权威树 + flush（worker 路径拿到回传的变更集也走这里——两个方向共一份应用逻辑）。
 *
 * 失败**抛**（不吞）：回写失败意味着 guest 的写丢了，调用方（exec）要把它变成 `Result` 上的错误，
 * 而不是拿着「看起来成功」的运行结果继续。
 */
export async function applyChanges(store: ShellFsStore, changes: WasiFsChanges): Promise<void> {
	const table = createMountTable(store.mounts);
	const ctx = BACKGROUND_CONTEXT;
	const fail = (op: string, path: string, error: { code: string; message: string }) => new Error(`回写失败（${op} ${path}）: ${error.code} ${error.message}`);
	// 顺序 = 变更集的契约：先删（含类型变了的旧节点），再建目录，最后写文件
	for (const path of changes.deleted) {
		const removed = await table.remove(path, { recursive: true, force: true }, ctx);
		if (!removed.ok) throw fail('remove', path, removed.error);
	}
	for (const path of changes.dirs) {
		const created = await table.createDir(path, { recursive: true }, ctx);
		if (!created.ok) throw fail('createDir', path, created.error);
	}
	for (const { path, data } of changes.written) {
		const written = await table.writeFile(path, data, ctx);
		if (!written.ok) throw fail('writeFile', path, written.error);
	}
	await flushMounts(store);
}

/** 按后端去重的 flush（默认表 '/' 是 IDB：超级块 500ms debounce；flush 契约见 BrowserFileSystem） */
export async function flushMounts(store: ShellFsStore): Promise<void> {
	for (const fs of new Set(store.mounts.map((m) => m.fs))) await fs.flush();
}
