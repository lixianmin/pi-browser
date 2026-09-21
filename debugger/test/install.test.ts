// debugger/test/install.test.ts —— bridge 幂等安装(spec Review Focus #3)。
// jsdom 提供 window;fs 行为复用 fake-indexeddb + handler。
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { installBridge, PI_BRIDGE_VERSION } from '../src/bridge/install';
import { resetHandlerCache } from '../src/bridge/handler';
import type { PiBridge } from '../src/bridge/install';

beforeEach(() => resetHandlerCache());

describe('installBridge', () => {
	it('首装:installed,window 上可见且版本正确', () => {
		expect(installBridge()).toBe('installed');
		const bridge = window.__piBrowserDebugger;
		expect(bridge?.version).toBe(PI_BRIDGE_VERSION);
		expect(typeof bridge?.call).toBe('function');
	});

	it('同版本再装:current,实例引用不变(不重复绑定)', () => {
		installBridge();
		const first = window.__piBrowserDebugger;
		expect(installBridge()).toBe('current');
		expect(window.__piBrowserDebugger).toBe(first);
	});

	it('旧版本对象:replaced(整体替换)', () => {
		window.__piBrowserDebugger = { version: PI_BRIDGE_VERSION - 1, call: () => Promise.reject(new Error('stale')) };
		expect(installBridge()).toBe('replaced');
		expect(window.__piBrowserDebugger?.version).toBe(PI_BRIDGE_VERSION);
	});

	it('安装后的 call 真正走 fs:write→read', async () => {
		installBridge();
		const bridge = window.__piBrowserDebugger as PiBridge;
		const w = await bridge.call('i-fs', { kind: 'write', path: '/x.txt', content: 'ok' });
		expect(w.ok).toBe(true);
		const r = await bridge.call('i-fs', { kind: 'read', path: '/x.txt' });
		expect(r.ok).toBe(true);
		if (!r.ok || r.value.kind !== 'read') throw new Error('unreachable');
		expect(r.value.content).toBe('ok');
	});
});
