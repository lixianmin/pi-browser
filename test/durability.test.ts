// @vitest-environment node
// spec §3 测试 3：真 IDB durability（这条路径 spice 现状测不到——vitest 下强制内存后端、
// 内存 flush 是 no-op，见 fs-adapters.ts:27-32,236）。所以这里 `memory: false` 强制 lightning-fs/IDB，
// 且断言 flush 被调用（承诺 flush 契约不在搬运中丢失，spec §8.2 的线上事故复发闸门）。
import './helpers/idb';
import { test, expect, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserFileSystem } from '../src/env/backend-idb';

// pi 的方法都要 chord Context；BACKGROUND_CONTEXT 是 pi 现成的背景上下文
const ctx = () => BACKGROUND_CONTEXT;

test('durability: write → flush → 同库新实例 → 读回', async () => {
	const a = createBrowserFileSystem({ dbName: 'durability-db', memory: false });
	await a.createDir('/spice-sessions', { recursive: true }, ctx());
	const w = await a.writeFile('/spice-sessions/x.jsonl', 'hello', ctx());
	expect(w.ok).toBe(true);
	const flushSpy = vi.spyOn(a, 'flush');
	await a.flush();
	expect(flushSpy).toHaveBeenCalledTimes(1);
	expect(flushSpy.mock.results[0]?.value).toBeInstanceOf(Promise);   // flush 是异步契约，调用方必须 await

	const b = createBrowserFileSystem({ dbName: 'durability-db', memory: false });
	const r = await b.readTextFile('/spice-sessions/x.jsonl', ctx());
	expect(r).toEqual({ ok: true, value: 'hello' });
	await b.cleanup(ctx());
});
