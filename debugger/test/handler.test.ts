// debugger/test/handler.test.ts —— bridge handler 的 op 语义(spec §6/§7)。
// 跑在 node + fake-indexeddb 上(lightning-fs 完整可用,主仓库先例);
// 每个用例独立 dbName,规避 lightning-fs 模块级实例表的状态泄漏。
import 'fake-indexeddb/auto';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserFileSystem } from '@lixianmin/pi-browser';
import { bytesToBase64, type FsOp } from '../src/shared/protocol';
import { handleOp, resetHandlerCache } from '../src/bridge/handler';

// seed:直接经 handler 自己写,保证走与被测路径一致的入口
async function seed(db: string, path: string, content: string | Uint8Array) {
	const r = await handleOp(db, {
		kind: 'write',
		path,
		content: typeof content === 'string' ? content : bytesToBase64(content),
		encoding: typeof content === 'string' ? 'text' : 'base64',
	});
	expect(r.ok).toBe(true);
}

const call = (db: string, op: FsOp) => handleOp(db, op);

beforeEach(() => resetHandlerCache());

describe('bridge handler', () => {
	it('write → list 层级(目录/文件、路径、大小)', async () => {
		await seed('h-list', '/s1/main.jsonl', 'abc');
		await seed('h-list', '/skills/echo/SKILL.md', 'x');
		const r = await call('h-list', { kind: 'list', path: '/' });
		expect(r.ok).toBe(true);
		if (!r.ok || r.value.kind !== 'list') return fail('unreachable');
		const names = r.value.entries.map((e) => e.name).sort();
		expect(names).toEqual(['s1', 'skills']);
		expect(r.value.entries.every((e) => e.kind === 'directory')).toBe(true);
	});

	it('write → read 文本往返', async () => {
		await seed('h-read', '/a.txt', 'héllo 世界');
		const r = await call('h-read', { kind: 'read', path: '/a.txt' });
		expect(r.ok).toBe(true);
		if (!r.ok || r.value.kind !== 'read') return fail('unreachable');
		expect(r.value.encoding).toBe('text');
		expect(r.value.content).toBe('héllo 世界');
		expect(r.value.truncated).toBe(false);
		expect(r.value.totalBytes).toBe(new TextEncoder().encode('héllo 世界').length);
	});

	it('read 二进制(含 0x00)→ base64', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x00, 0xff]);
		await seed('h-bin', '/img.bin', bytes);
		const r = await call('h-bin', { kind: 'read', path: '/img.bin' });
		expect(r.ok).toBe(true);
		if (!r.ok || r.value.kind !== 'read') return fail('unreachable');
		expect(r.value.encoding).toBe('base64');
		expect(r.value.totalBytes).toBe(4);
	});

	it('read 超 maxBytes → truncated 且截断', async () => {
		const big = 'x'.repeat(5000);
		await seed('h-trunc', '/big.txt', big);
		const r = await call('h-trunc', { kind: 'read', path: '/big.txt', maxBytes: 1000 });
		expect(r.ok).toBe(true);
		if (!r.ok || r.value.kind !== 'read') return fail('unreachable');
		expect(r.value.encoding).toBe('text');
		expect(r.value.truncated).toBe(true);
		expect(r.value.content).toHaveLength(1000);
		expect(r.value.totalBytes).toBe(5000);
	});

	it('mkdir → write 子文件 → delete(recursive) → stat not_found', async () => {
		expect((await call('h-del', { kind: 'mkdir', path: '/d1/d2' })).ok).toBe(true);
		await seed('h-del', '/d1/d2/f.txt', 'v');
		const del = await call('h-del', { kind: 'delete', path: '/d1', recursive: true });
		expect(del).toEqual({ ok: true, value: { kind: 'delete' } });
		const st = await call('h-del', { kind: 'stat', path: '/d1' });
		expect(st).toEqual({ ok: false, error: { code: 'not_found', message: expect.any(String) } });
	});

	it('rename 后旧路径 not_found、新路径可读', async () => {
		await seed('h-ren', '/a.txt', 'data');
		expect((await call('h-ren', { kind: 'rename', from: '/a.txt', to: '/b/c.txt' })).ok).toBe(true);
		expect((await call('h-ren', { kind: 'stat', path: '/a.txt' })).ok).toBe(false);
		const r = await call('h-ren', { kind: 'read', path: '/b/c.txt' });
		if (!r.ok || r.value.kind !== 'read') return fail('unreachable');
		expect(r.value.content).toBe('data');
	});

	it('未命中路径 → not_found', async () => {
		const r = await call('h-miss', { kind: 'list', path: '/nope' });
		expect(r).toEqual({ ok: false, error: { code: 'not_found', message: expect.any(String) } });
	});

	it('databases:两个库各写一个文件 → names 含两者且排序', async () => {
		await seed('h-db-b', '/f', '1');
		await seed('h-db-a', '/f', '2');
		const r = await call('h-db-a', { kind: 'databases' });
		expect(r.ok).toBe(true);
		if (!r.ok || r.value.kind !== 'databases') return fail('unreachable');
		const names = r.value.names.filter((n) => n.startsWith('h-db-'));
		expect(names).toEqual(['h-db-a', 'h-db-b']);
	});

	it('flush 契约:write 后新开实例可读(超级块落盘)', async () => {
		await seed('h-flush', '/session/main.jsonl', '{"role":"user"}');
		// 新的 BrowserFileSystem 实例模拟宿主页面刷新后重开
		const fresh = createBrowserFileSystem({ dbName: 'h-flush', memory: false });
		const r = await fresh.readTextFile('/session/main.jsonl', BACKGROUND_CONTEXT);
		expect(r).toEqual({ ok: true, value: '{"role":"user"}' });
	});

	it('所有返回值 JSON 往返不变', async () => {
		await seed('h-json', '/a.txt', 'v');
		for (const op of [
			{ kind: 'list', path: '/' },
			{ kind: 'read', path: '/a.txt' },
			{ kind: 'stat', path: '/a.txt' },
		] as FsOp[]) {
			const r = await call('h-json', op);
			expect(JSON.parse(JSON.stringify(r))).toEqual(r);
		}
	});
});

function fail(msg: string): never {
	throw new Error(msg);
}
