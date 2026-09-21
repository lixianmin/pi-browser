// debugger/test/transport.test.ts —— 面板侧传输层:消息形状 + inspected tabId 透传。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOp, onNavigated } from '../src/panel/transport';

const chromeStub = {
	devtools: {
		inspectedWindow: { tabId: 123 },
		network: { onNavigated: { addListener: vi.fn() } },
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

	it('onNavigated 注册到 devtools.network', () => {
		const cb = () => {};
		onNavigated(cb);
		expect(chromeStub.devtools.network.onNavigated.addListener).toHaveBeenCalledWith(cb);
	});
});
