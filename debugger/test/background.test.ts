// debugger/test/background.test.ts —— ensure/call 注入封装 + 消息路由。
// chrome.* 全部 mock:钉住 world:'MAIN'、files/func 注入切换、异常回 bridge_unreachable。
import { describe, expect, it, vi } from 'vitest';
import { callBridge, ensureBridge, PI_BRIDGE_VERSION, type ScriptingLike } from '../src/background/inject';
import { createMessageHandler } from '../src/background/router';

function mockScripting(results: Array<{ result?: unknown } | Error> = []): ScriptingLike & { calls: unknown[] } {
	const calls: unknown[] = [];
	return {
		calls,
		executeScript: vi.fn(async (inj: unknown) => {
			calls.push(inj);
			const r = results[calls.length - 1];
			if (r instanceof Error) throw r;
			return [r ?? { result: undefined }];
		}),
	} as never;
}

describe('ensureBridge', () => {
	it('版本命中 → 只做一次 func 探测,不注文件', async () => {
		const scripting = mockScripting([{ result: PI_BRIDGE_VERSION }]);
		await ensureBridge(scripting, 42);
		expect(scripting.executeScript).toHaveBeenCalledTimes(1);
		const inj = scripting.calls[0] as { world?: string; func?: unknown; files?: string[] };
		expect(inj.world).toBe('MAIN');
		expect(inj.func).toBeTypeOf('function');
		expect(inj.files).toBeUndefined();
	});

	it('版本缺失/不符 → 追加 files 注入 bridge.js', async () => {
		const scripting = mockScripting([{ result: null }, { result: undefined }]);
		await ensureBridge(scripting, 42);
		expect(scripting.executeScript).toHaveBeenCalledTimes(2);
		const second = scripting.calls[1] as { world?: string; files?: string[] };
		expect(second.files).toEqual(['bridge.js']);
		expect(second.world).toBe('MAIN');
	});
});

describe('callBridge', () => {
	it('func+args 注入并取回 result', async () => {
		const scripting = mockScripting([{ result: { ok: true, value: { kind: 'delete' } } }]);
		const r = await callBridge(scripting, 7, 'db1', { kind: 'mkdir', path: '/x' });
		expect(r).toEqual({ ok: true, value: { kind: 'delete' } });
		const inj = scripting.calls[0] as { args?: unknown[]; world?: string };
		expect(inj.world).toBe('MAIN');
		expect(inj.args).toEqual(['db1', { kind: 'mkdir', path: '/x' }]);
	});

	it('注入抛错 → 异常向上传(由 router 转结构化错误)', async () => {
		const scripting = mockScripting([new Error('tab closed')]);
		await expect(callBridge(scripting, 7, 'db1', { kind: 'databases' })).rejects.toThrow('tab closed');
	});
});

describe('createMessageHandler', () => {
	const deps = {
		ensureBridge: vi.fn(async () => {}),
		callBridge: vi.fn(async () => ({ ok: true, value: { kind: 'databases', names: ['x'] } }) as never),
	};

	it('pi-debugger-call:ensure → call → sendResponse(result),返回 true', async () => {
		const respond = vi.fn();
		const keepOpen = createMessageHandler(deps)(
			{ type: 'pi-debugger-call', tabId: 9, dbName: 'db', op: { kind: 'databases' } },
			{},
			respond,
		);
		expect(keepOpen).toBe(true);
		await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true, value: { kind: 'databases', names: ['x'] } }));
		expect(deps.ensureBridge).toHaveBeenCalledWith(9);
		expect(deps.callBridge).toHaveBeenCalledWith(9, 'db', { kind: 'databases' });
	});

	it('注入失败 → sendResponse({ok:false, bridge_unreachable})', async () => {
		const respond = vi.fn();
		createMessageHandler({ ...deps, ensureBridge: vi.fn(async () => Promise.reject(new Error('no host'))) })(
			{ type: 'pi-debugger-call', tabId: 9, dbName: null, op: { kind: 'databases' } },
			{},
			respond,
		);
		await vi.waitFor(() =>
			expect(respond).toHaveBeenCalledWith({
				ok: false,
				error: { code: 'bridge_unreachable', message: expect.stringContaining('no host') },
			}),
		);
	});

	it('其他消息:返回 false 不接管', () => {
		const respond = vi.fn();
		expect(createMessageHandler(deps)({ type: 'other' }, {}, respond)).toBe(false);
		expect(respond).not.toHaveBeenCalled();
	});
});
