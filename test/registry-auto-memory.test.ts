// @vitest-environment node
// 自动内存路径（无 indexedDB）的注册表行为：同 dbName 共享同一 LightningFS+MemoryBackend 内核。
// 这是 spice 全部 vitest（jsdom/node 无 IDB）跨视图共享的支撑机制（spec C3 v2.1）——
// v2 之前这里走 createMemoryFileSystem 早返回、每调用独立世界。
// **禁止 import './helpers/idb'**：本文件必须在真·无 indexedDB 环境断言自动内存分支。
import { describe, it, expect, beforeEach } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserFileSystem, resetFsKernelRegistry } from '../src/env/backend-idb';

const CTX = BACKGROUND_CONTEXT;

beforeEach(() => { resetFsKernelRegistry(); });

describe('自动内存（无 IDB）注册表', () => {
	it('同 dbName 两个闭包（不同 cwd）：A 写 B 读（LightningFS+MemoryBackend 内核共享）', async () => {
		const dbName = `am-${Math.random().toString(36).slice(2)}`;
		const a = createBrowserFileSystem({ dbName });
		const b = createBrowserFileSystem({ dbName, cwd: '/other' });
		expect((await a.writeFile('/projects/p1/f.txt', 'shared', CTX)).ok).toBe(true);
		expect(await b.readTextFile('/projects/p1/f.txt', CTX)).toEqual({ ok: true, value: 'shared' });
	});

	it('不同 dbName 互相隔离', async () => {
		const a = createBrowserFileSystem({ dbName: `am-a-${Math.random().toString(36).slice(2)}` });
		const b = createBrowserFileSystem({ dbName: `am-b-${Math.random().toString(36).slice(2)}` });
		await a.writeFile('/x.txt', 'a', CTX);
		expect(await b.readTextFile('/x.txt', CTX)).toMatchObject({ ok: false });
	});

	it('显式 memory:true 与自动内存世界互不可见（零交互）', async () => {
		const dbName = `am-${Math.random().toString(36).slice(2)}`;
	 const memo = createBrowserFileSystem({ dbName, memory: true });
		const auto = createBrowserFileSystem({ dbName });
		await memo.writeFile('/m.txt', 'memo', CTX);
		expect(await auto.readTextFile('/m.txt', CTX)).toMatchObject({ ok: false });
	});
});
