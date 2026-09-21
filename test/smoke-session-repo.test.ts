// @vitest-environment node
// spec §4：pi-browser 的 fs 承载真 `JsonlSessionRepo` 的往返（spice M2 的消费方式）。
// 真 IDB：`memory: false` + fake-indexeddb（helpers/idb）+ 同库新实例读回 = 「刷新页面」的代理。
//
// 偏离计划骨架之处（API 以实际签名为准）：计划草稿写 `repo.load('s1')`，但 JsonlSessionRepo 没有
// load（只有 create/open/list/delete/fork）——打开会话要 `list()` 取元数据再 `open(meta)`，
// 且派生的分支得自己建（pi 的 create() 不建分支，spice 的 createSessionStore 同此处理）。
import './helpers/idb';
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from '@earendil-works/pi-agent-core';
import { createBrowserFileSystem, resetFsKernelRegistry } from '../src/index';

const CTX = BACKGROUND_CONTEXT;

describe('JsonlSessionRepo 在 pi-browser fs 上往返（S3 消费切换的前提验证）', () => {
	it('create → append → flush → 同库新实例重开读回', async () => {
		const fs = createBrowserFileSystem({ dbName: 'smoke-db', memory: false });
		const repo = new JsonlSessionRepo({ fileSystem: fs, sessionsRoot: '/spice-sessions' });
		const session = await repo.create({ id: 's1', cwd: '/' }, CTX);
		const branch = (await session.branch('main', CTX)) ?? (await session.createBranch('main', null, CTX));
		await branch.appendMessage({ role: 'user', content: '你好', timestamp: 1 }, CTX);
		await branch.appendCustomEntry('spiceRound', { n: 1 }, CTX);
		// durability 契约：写入 resolve 后由调用方 flush（lightning-fs 超级块 500ms debounce）
		await fs.flush();

		// 新实例（= 刷新页面后重建 fs）读回：会话文件与目录项都必须在 IDB 里
		// 清内核注册表：reopenedFs 必须是真·新实例从 IDB 重载，否则共享 CacheFS 恒绿、不再测落盘本身
		resetFsKernelRegistry();
		const reopenedFs = createBrowserFileSystem({ dbName: 'smoke-db', memory: false });
		const repo2 = new JsonlSessionRepo({ fileSystem: reopenedFs, sessionsRoot: '/spice-sessions' });
		const meta = (await repo2.list(undefined, CTX)).find((m) => m.id === 's1');
		expect(meta).toBeDefined();
		const reopened = await repo2.open(meta!, CTX);
		const reopenedBranch = await reopened.branch('main', CTX);
		expect(reopenedBranch).toBeDefined();
		const entries = await reopenedBranch!.findEntries({ order: 'oldestFirst' }, CTX);
		expect(entries.map((e) => e.type)).toEqual(['message', 'custom']);
		expect(entries[0].type === 'message' && entries[0].message).toEqual({ role: 'user', content: '你好', timestamp: 1 });
		expect(entries[1].type === 'custom' && entries[1].customType).toBe('spiceRound');

		await reopenedFs.cleanup(CTX);
		await fs.cleanup(CTX);
	});
});
