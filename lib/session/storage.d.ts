import { type JsonlStorageOptions } from '@earendil-works/pi-durable/storage/jsonl';
import type { Storage } from '@earendil-works/pi-durable';
import type { FileSystem } from '@earendil-works/pi-durable/env';
import type { Context } from '../env/context.js';
/**
 * 在本仓的浏览器 fs 上打开（或新建）一个 pi-durable 会话存储。
 *
 * @param directory 存储目录（相对路径按 `fs.cwd` 解析）；不存在时 `open` 会递归创建
 * @param fs        会话存储的宿主文件系统。本仓 `BrowserFileSystem` 是它的超集，直接传即可；
 *                  参数类型收在**契约**（`FileSystem`）而不是本仓子类，是因为本函数只做透传——
 *                  宿主的装配层（如 `@spice/harness` 的 SessionStore）手里只有契约类型，
 *                  收窄成子类只会逼调用方 `as` 断言。
 * @param context   chord `Context`（与 fs 各方法同一个；`BACKGROUND_CONTEXT` 即可）
 * @param options   原样透传给 `JsonlStorage.open`（目前只有 `fsync`）
 * @returns `Storage` 契约——`createSession(storage)` 的入参
 */
export declare function openBrowserSessionStorage(directory: string, fs: FileSystem, context: Context, options?: JsonlStorageOptions): Promise<Storage>;
