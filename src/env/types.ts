// src/env/types.ts —— pi `FileSystem` 契约在浏览器侧的扩展（源：spice `packages/harness/src/session/fs-adapters.ts:36-58`
// 的 Spice* 同名件，逐字平移改名）。
// 上游类型统一从这里 re-export：src/** 只从 `.`、`./harness/session` 这两个上游入口拿东西，deep import 各自散落会漂。
import type { FileSystem, FileError, FileInfo, Result, ExecutionEnv, Context } from '@earendil-works/pi-agent-core';

export type { FileSystem, FileError, FileInfo, Result, ExecutionEnv };

/**
 * pi 1.0.0 给 `FileSystem` 新增的三条（`pi-durable@1.0.0 dist/env/index.d.ts`）：
 * `id`（文件命名空间标识）、`truncateFile`、`flushFile`。
 *
 * 为什么换源前要在这里显式声明：本批先把这三条实现出来（T1.3），换源在之后（T1.4）。
 * 在换源之前 `FileSystem` 还是 0.99.1 的、没有这三条，后端以对象字面量返回
 * `BrowserFileSystem`/`MountTable` 会撞上 TS 的多余属性检查。**T1.4 换源后删掉本接口**——
 * 那时这三条由上游 `FileSystem` 提供。
 */
export interface FileSystemV1Additions {
	readonly id: string;
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>>;
	flushFile(path: string, context: Context): Promise<Result<void, FileError>>;
}

/**
 * pi FileSystem 的浏览器扩展：在 pi 契约之外额外暴露 `flush()` 强制落盘。
 *
 * 为何需要：lightning-fs 的超级块（目录树）写入是 **500ms debounce**（DefaultBackend.saveSuperblock）——
 * `writeFile()` resolve 时文件内容已进 IndexedDB，但目录项/路径映射可能还没写。此时刷新页面会
 * 「文件内容在、路径丢了」，表现为会话消息读不回来（e2e chat.spec 实证）。会话存储每回合末调 flush 兑现 durability。
 *
 * 共享语义（fs 边界重构 spec，2026-09-21）：同 dbName 的实例共享同一内核（注册表），多 cwd 视图读写互通；
 * `appendFile` 是读旧→拼接→写回，**非原子**——跨视图并发追加同一文件需调用方自行串行。
 */
export interface BrowserFileSystem extends FileSystem, FileSystemV1Additions {
	flush(): Promise<void>;
}

/**
 * 挂载条目：绝对前缀 → 后端 fs（spec §3.1 的公开面登记类型；`mount.ts` 与 `shell/` 共用一份）。
 *
 * 定义在 types.ts 而不是 mount.ts：shell 适配器的注入面就是它（`{ mounts: MountEntry[] }`），
 * 类型住在谁实现路由无关，只跟「谁要用」有关。
 */
export interface MountEntry {
	/** 挂载前缀（绝对路径，如 '/'、'/tmp'） */
	prefix: string;
	fs: BrowserFileSystem;
}
