// @vitest-environment node
// 批 2 B-1：pi-durable 的 `JsonlStorage` 装到**本仓的浏览器 fs（真 IDB）**上，跨 fs 实例往返。
//
// 形状照 `test/session-fs-roundtrip.test.ts`：写 → flush → `resetFsKernelRegistry()` + 新建 fs 实例
// （= 刷新页面）→ 重开**同一目录** → 读回，断言逐字一致。区别只在写入端——这里是上游
// `createSession` 的 commit（`tx.createConversation` + `tx.appendEntry`），不是本仓手拼的 JSONL 行。
import './helpers/idb';
import { describe, it, expect } from 'vitest';
import { createSession } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { createBrowserFileSystem, resetFsKernelRegistry, openBrowserSessionStorage } from '../src/index';

const CTX = BACKGROUND_CONTEXT;
const STORAGE_DIR = '/sessions/durable-rt';

describe('pi-durable 存储在浏览器 fs 上的跨实例往返（真 IDB）', () => {
	it('写入 → flush → 新 fs 实例重开同一目录：conversation 与 entry 逐字读回', async () => {
		const fs = createBrowserFileSystem({ dbName: 'durable-rt', memory: false });
		const storage = await openBrowserSessionStorage(STORAGE_DIR, fs, CTX);
		const session = createSession(storage);
		const { conversationId, entryId } = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
			const entry = await tx.appendEntry(conversation.id, {
				kind: 'message',
				data: { role: 'user', content: '你好，浏览器' },
				head: 'self',
			});
			return { conversationId: conversation.id, entryId: entry.id };
		}, CTX);
		await session.close(CTX);
		await fs.flush();

		// 刷新页面：清内核注册表 → 新 fs 实例 → 重开同一目录
		resetFsKernelRegistry();
		const reopenedFs = createBrowserFileSystem({ dbName: 'durable-rt', memory: false });
		const reopened = await openBrowserSessionStorage(STORAGE_DIR, reopenedFs, CTX);

		const conversation = await reopened.conversation(conversationId, CTX);
		expect(conversation).toEqual({ id: conversationId });

		const page = await reopened.scanEntries({ conversationId }, 10, undefined, CTX);
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toEqual({
			id: entryId,
			conversationId,
			kind: 'message',
			data: { role: 'user', content: '你好，浏览器' },
			head: entryId,
		});

		await reopened.close(CTX);
		await reopenedFs.cleanup(CTX);
		await fs.cleanup(CTX);
	});
});
