import { type JsonlStorageOptions } from '@earendil-works/pi-durable/storage/jsonl';
import type { Storage } from '@earendil-works/pi-durable';
import type { Context } from '../env/context.js';
import type { BrowserFileSystem } from '../env/types.js';
/**
 * 在本仓的浏览器 fs 上打开（或新建）一个 pi-durable 会话存储。
 *
 * @param directory 存储目录（相对路径按 `fs.cwd` 解析）；不存在时 `open` 会递归创建
 * @param fs        本仓的浏览器文件系统（`createBrowserFileSystem` 的产物）
 * @param context   chord `Context`（与 fs 各方法同一个；`BACKGROUND_CONTEXT` 即可）
 * @param options   原样透传给 `JsonlStorage.open`（目前只有 `fsync`）
 * @returns `Storage` 契约——`createSession(storage)` 的入参
 */
export declare function openBrowserSessionStorage(directory: string, fs: BrowserFileSystem, context: Context, options?: JsonlStorageOptions): Promise<Storage>;
