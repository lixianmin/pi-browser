// src/index.ts —— 公开面：只出这五个（spec §3）。浏览器产物面禁 deep import——消费者一律从这个入口拿，
// 也只在 `.` / `./harness/session` 两个上游入口取东西（deep import 各自散落会随上游内部重构漂）。
// `createMemoryFileSystem` 是内部件不导出（现无外部消费者，AGENTS §2）；memory/idb 两个后端的契约
// 由测试直接 import src/env/* 覆盖（spec §3 测试 1）。
export { createBrowserFileSystem, type BrowserFileSystemOptions } from './env/backend-idb';
export type { BrowserFileSystem } from './env/types';
export { normalizePath } from './env/path';
export { createBrowserExecutionEnv } from './env/execution-env';
