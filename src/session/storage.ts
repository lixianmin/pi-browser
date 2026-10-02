// src/session/storage.ts —— pi-durable 会话存储在**浏览器侧**的装配（1.0.0 批 2 B-1）。
//
// 为什么存在：pi 1.0.0 把 `pi-agent-core` 的 `harness/` 整块删掉，会话/编排模型落到
// `@earendil-works/pi-durable`。它的存储层是 **fs 注入**的——`JsonlStorage` 自己不开文件、不 import
// `node:fs`，只经 `FileSystem` 契约读写；而「浏览器那端的 `FileSystem`」正是本仓的 `BrowserFileSystem`
// （lightning-fs / IndexedDB，见 src/env/backend-idb.ts）。上游给的自开文件入口只有
// `pi-durable/storage/jsonl/node`（直接 `node:fs`，浏览器用不了），所以浏览器宿主必须自己造
// `JsonlStorage`——本模块就是那一步。批 2 的其余装配（会话/harness = B-2、工具接线 = B-3、
// compaction = B-4）不在这里。
//
// 与 `JsonlStorage.open` 的关系：一层薄封装，`options` 原样透传，返回 `Storage` 契约
// （`createSession(storage)` 吃的正是它；`Storage` 已含 `close`，不需要具体类上的别的东西）。
//
// 为什么不需要写 adapter（2026-10-02 在 1.0.0 产物上复核）：
//   · `dist/storage/jsonl/storage.js` 的全部 import 只有 `../../ids.js` 与 `../memory.js`（本包内件），
//     **零 `node:` 依赖** → 浏览器可打包；
//   · `BrowserFileSystem extends FileSystem`（src/env/types.ts），是契约的**超集**（多一个自有
//     `flush()`），直接传入即可，**不需要 `as` 断言、不需要补方法**；
//   · `JsonlStorage` 实际调用的 fs 方法共 11 个——`absolutePath` `appendFile` `createDir` `flushFile`
//     `joinPath` `listDir` `readBinaryFile` `remove` `renameFile` `truncateFile` `writeFile`——
//     全在 `FileSystem` 契约内，IDB / 内存两个后端都实现。
//
// 落盘语义沿用 `BrowserFileSystem` 的既有约定：lightning-fs 的目录项写入是 500ms debounce，
// 会话写入方在需要 durability 的时机调 `fs.flush()`（`JsonlStorageOptions.fsync` 走的是逐 sidecar
// 的 `flushFile`，与 superblock 落盘不是一回事）。
import { JsonlStorage, type JsonlStorageOptions } from '@earendil-works/pi-durable/storage/jsonl';
import type { Storage } from '@earendil-works/pi-durable';
import type { Context } from '../env/context';
import type { BrowserFileSystem } from '../env/types';

/**
 * 在本仓的浏览器 fs 上打开（或新建）一个 pi-durable 会话存储。
 *
 * @param directory 存储目录（相对路径按 `fs.cwd` 解析）；不存在时 `open` 会递归创建
 * @param fs        本仓的浏览器文件系统（`createBrowserFileSystem` 的产物）
 * @param context   chord `Context`（与 fs 各方法同一个；`BACKGROUND_CONTEXT` 即可）
 * @param options   原样透传给 `JsonlStorage.open`（目前只有 `fsync`）
 * @returns `Storage` 契约——`createSession(storage)` 的入参
 */
export async function openBrowserSessionStorage(
	directory: string,
	fs: BrowserFileSystem,
	context: Context,
	options?: JsonlStorageOptions,
): Promise<Storage> {
	return JsonlStorage.open(directory, fs, context, options);
}
