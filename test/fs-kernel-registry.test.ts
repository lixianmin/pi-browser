// @vitest-environment node
// fs 内核注册表（工程 fs 边界重构 spec §3，2026-09-21）：**同 dbName = 同世界**。
// 持久路径（fake-indexeddb 真 IDB）与显式 memory:true 隔离、reset 逃生口。
// 自愈写回的覆盖边界见 registry-heal.test.ts 的诚实记录（catch 分支不可驱动，R9）。
// 自动内存（无 IDB）路径的注册表行为见 registry-auto-memory.test.ts（本文件有 fake indexedDB，走不到）。
import './helpers/idb';
import { describe, it, expect, beforeEach } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserFileSystem, resetFsKernelRegistry } from '../src/env/backend-idb';

const CTX = BACKGROUND_CONTEXT;
const rnd = () => `reg-${Math.random().toString(36).slice(2)}`;

beforeEach(() => { resetFsKernelRegistry(); });

describe('fs 内核注册表：同 dbName = 同世界（持久路径）', () => {
	it('同 dbName 两个闭包：A 写 B 立即可读（内核共享）', async () => {
		const dbName = rnd();
		const a = createBrowserFileSystem({ dbName, memory: false });
		const b = createBrowserFileSystem({ dbName, memory: false });
		expect((await a.writeFile('/x/a.txt', 'from-a', CTX)).ok).toBe(true);
		expect(await b.readTextFile('/x/a.txt', CTX)).toEqual({ ok: true, value: 'from-a' });
	});

	it('同 dbName 不同 cwd 的两个视图同世界（cwd 不进注册表 key；pi 契约里 cwd 只作用于 absolutePath）', async () => {
		const dbName = rnd();
		const root = createBrowserFileSystem({ dbName, memory: false });
		const view = createBrowserFileSystem({ dbName, cwd: '/projects/p1', memory: false });
		expect((await root.writeFile('/projects/p1/sketch.ino', 'ok', CTX)).ok).toBe(true);
		expect(await view.absolutePath('sketch.ino', CTX)).toEqual({ ok: true, value: '/projects/p1/sketch.ino' });
		expect(await view.readTextFile('/projects/p1/sketch.ino', CTX)).toEqual({ ok: true, value: 'ok' });
	});

	it('显式 memory:true 不入注册表：同 dbName 两次调用也是两个独立世界，且不触持久内核', async () => {
		const dbName = rnd();
		const a = createBrowserFileSystem({ dbName, memory: true });
		const b = createBrowserFileSystem({ dbName, memory: true });
		expect((await a.writeFile('/only-a.txt', 'a', CTX)).ok).toBe(true);
		expect(await b.readTextFile('/only-a.txt', CTX)).toMatchObject({ ok: false });
		const durable = createBrowserFileSystem({ dbName, memory: false });
		expect(await durable.readTextFile('/only-a.txt', CTX)).toMatchObject({ ok: false });
	});

	it('reset 后同 dbName 新实例从 IDB 重新加载（durability 命题保留；未 flush 改动会被 deactivate 全量落盘，不在此断言）', async () => {
		const dbName = rnd();
		const a = createBrowserFileSystem({ dbName, memory: false });
		await a.writeFile('/d.txt', 'data', CTX);
		await a.flush();
		resetFsKernelRegistry();
		const b = createBrowserFileSystem({ dbName, memory: false });
		// 不 reset 时 b 共享 a 的 CacheFS、读回不触 IDB；reset 后 b 是全新内核，读回必须经 IDB 加载。
		expect(await b.readTextFile('/d.txt', CTX)).toEqual({ ok: true, value: 'data' });
	});
});

describe('适配层契约收口（readFile-null / remove 目录归一）', () => {
	it('readTextFile 命中目录：统一 not_found（LFS 系内核原返回 ok(null)）', async () => {
		const fs = createBrowserFileSystem({ dbName: rnd(), memory: false });
		await fs.createDir('/d', { recursive: true }, CTX);
		expect(await fs.readTextFile('/d', CTX)).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});

	it('remove 非递删目录：统一 is_directory（LFS 系内核原静默删条目留孤儿）；recursive 不受影响', async () => {
		const fs = createBrowserFileSystem({ dbName: rnd(), memory: false });
		await fs.writeFile('/d/inner.txt', 'x', CTX);
		expect(await fs.remove('/d', { recursive: false }, CTX)).toMatchObject({ ok: false, error: { code: 'is_directory' } });
		expect(await fs.remove('/d', { recursive: true, force: true }, CTX)).toMatchObject({ ok: true });
		await fs.createDir('/empty', {}, CTX);
		expect(await fs.remove('/empty', {}, CTX)).toMatchObject({ ok: false, error: { code: 'is_directory' } });
	});
});
