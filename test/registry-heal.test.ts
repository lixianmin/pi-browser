// @vitest-environment node
// 内核注册表的「无 IDB 收敛」断言（fs 边界重构 spec §3 C3）：memory:false 在 indexedDB 从在到不在时，
// 同 dbName 的多个闭包收敛到**同一个**内存世界（不是各自自愈出 N 个世界——round-1 P1 的关切）。
//
// 诚实记录（§0.3）：catch 分支的「自愈写回」**不可用测试驱动**——实证 lightning-fs 的 IDB init 发生在
// detached promise 里（PromisifiedFS.js:84 → DefaultBackend.init → new IdbBackend → idb-keyval Store._init
// → indexedDB.open 抛错），错误不冒泡到被 await 的 op（op 永不 settle，实测 5s 超时 + unhandled rejection）。
// 因此覆盖只能到「收敛结果」这一层；R9 仍禁止 stub 驱动自愈（会引入 unhandled rejection 假阳性）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserFileSystem, resetFsKernelRegistry } from '../src/env/backend-idb';

const CTX = BACKGROUND_CONTEXT;

afterEach(() => { resetFsKernelRegistry(); vi.unstubAllGlobals(); });

describe('无 IDB 时的内核收敛（memory:false）', () => {
	it('indexedDB 从在到不在后，同 dbName 两个闭包共享同一内存世界', async () => {
		resetFsKernelRegistry();
		const dbName = `heal-${Math.random().toString(36).slice(2)}`;
		// 真 fake-indexeddb 未 import（本文件无 helpers/idb）→ indexedDB 本来就是 undefined；
		// 显式声明一次「曾经存在」再撤掉，模拟 jsdom stub 撤销窗口。
		vi.stubGlobal('indexedDB', undefined);
		const a = createBrowserFileSystem({ dbName, memory: false });
		const w = await a.writeFile('/x.txt', 'v', CTX);
		expect(w.ok).toBe(true);
		const b = createBrowserFileSystem({ dbName, memory: false });
		expect(await b.readTextFile('/x.txt', CTX)).toEqual({ ok: true, value: 'v' });   // 同世界（注册表键控）
	});
});
