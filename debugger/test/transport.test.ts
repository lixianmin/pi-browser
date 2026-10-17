// debugger/test/transport.test.ts —— 面板侧传输层:消息形状 + inspected tabId 透传。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOp, onNavigated } from '../src/panel/transport';

const chromeStub = {
	devtools: {
		inspectedWindow: { tabId: 123 },
		network: { onNavigated: { addListener: vi.fn(), removeListener: vi.fn() } },
	},
	runtime: { sendMessage: vi.fn(async (): Promise<unknown> => ({ ok: true, value: { kind: 'delete' } })) },
};

vi.stubGlobal('chrome', chromeStub);

afterEach(() => vi.clearAllMocks());

describe('transport', () => {
	it('callOp:消息形状 {type,tabId,dbName,op},tabId 取自 inspectedWindow', async () => {
		const r = await callOp({ kind: 'list', path: '/' }, 'db1');
		expect(r).toEqual({ ok: true, value: { kind: 'delete' } });
		expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith({
			type: 'pi-debugger-call',
			tabId: 123,
			dbName: 'db1',
			op: { kind: 'list', path: '/' },
		});
	});

	it('空应答(background 缺失)→ 结构化 bridge_unreachable', async () => {
		chromeStub.runtime.sendMessage.mockResolvedValueOnce(undefined);
		const r = await callOp({ kind: 'databases' }, null);
		expect(r).toEqual({
			ok: false,
			error: { code: 'bridge_unreachable', message: expect.any(String) },
		});
	});

	it('onNavigated 注册到 devtools.network，返回的退订函数真的移除监听', () => {
		const cb = () => {};
		const off = onNavigated(cb);
		expect(chromeStub.devtools.network.onNavigated.addListener).toHaveBeenCalledWith(cb);
		off();
		expect(chromeStub.devtools.network.onNavigated.removeListener).toHaveBeenCalledWith(cb);
	});

	it('sendMessage reject（扩展被 reload）→ 结构化 bridge_unreachable，不向调用方抛', async () => {
		chromeStub.runtime.sendMessage.mockRejectedValueOnce(new Error('Extension context invalidated'));
		const r = await callOp({ kind: 'databases' }, null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe('bridge_unreachable');
	});
});
