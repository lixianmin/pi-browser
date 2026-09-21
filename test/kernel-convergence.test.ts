// @vitest-environment node
// 无 IDB 时的内核收敛断言（spec §3 C3）：`memory:false` 在无 indexedDB 环境下，同 dbName 的多个闭包
// 收敛到**同一个**内存世界（不是各自建出 N 个世界）。
//
// 诚实记录（探针实证，2026-09-21）：onFs 的 catch 自愈分支**不可驱动、实为防御性代码**——
// 用合规 stub（open 返回 request，异步 onerror 携带 ReferenceError('indexedDB is not defined')，
// 对照 idb-keyval `Store._init`）驱动 IDB 内核首个操作时，该 op **永不 settle**（Promise.race 实测 TIMEOUT，
// 两次独立复现），即错误不冒泡到被 await 的 op。含义：破 IDB 环境的真实表现是**挂起**（上游 lightning-fs
// 行为，非本重构引入），自愈写回只在错误真的冒泡时才有意义（保留为防御）。
// 因此覆盖只能到「收敛结果」这一层；R9 仍禁止用 stub 驱动自愈（会引入 unhandled rejection 假阳性）。
import { describe, it, expect, afterEach } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserFileSystem, resetFsKernelRegistry } from '../src/env/backend-idb';

const CTX = BACKGROUND_CONTEXT;

afterEach(() => { resetFsKernelRegistry(); });

describe('无 IDB 时的内核收敛（memory:false）', () => {
	it('indexedDB 为 undefined 时，同 dbName 两闭包共享同一内存世界（收敛结果，非自愈路径）', async () => {
		resetFsKernelRegistry();
		const dbName = `no-idb-${Math.random().toString(36).slice(2)}`;
		const a = createBrowserFileSystem({ dbName, memory: false });   // 无 IDB：getKernel 直接建 MemoryBackend 内核
		const w = await a.writeFile('/x.txt', 'v', CTX);
		expect(w.ok).toBe(true);
		const b = createBrowserFileSystem({ dbName, memory: false });
		expect(await b.readTextFile('/x.txt', CTX)).toEqual({ ok: true, value: 'v' });
	});
});
