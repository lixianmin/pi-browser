// test/extensions-runtime.test.ts —— P3 Task 18：`ExtensionRuntime` / `bindCore` 契约。
// 关键不是「拷贝动作」，而是三件容易静默出错的事：
//   ① bindCore 前调用动作 → 响亮抛错（不能静默用旧/空动作）；
//   ② invalidate 后 assertActive → 抛（扩展实例失效）；
//   ③ 事件总线订阅在 invalidate 时统一退订（否则 reload 后旧订阅泄漏）。
import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { createExtensionRuntime, bindCore, type ExtensionActions, type ExtensionRuntime } from '../src/extensions/runtime';

const actions = (overrides: Partial<ExtensionActions> = {}): ExtensionActions => ({
	sendUserMessage: vi.fn(),
	appendEntry: vi.fn(),
	setSessionName: vi.fn(),
	getSessionName: () => 's',
	setLabel: vi.fn(),
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: vi.fn(),
	setModel: async () => true,
	getThinkingLevel: () => 'medium',
	setThinkingLevel: vi.fn(),
	...overrides,
});

describe('ExtensionRuntime / bindCore', () => {
	it('bindCore 前：动作与 createContext 都响亮抛错', () => {
		const runtime = createExtensionRuntime();
		expect(() => runtime.getSessionName()).toThrow(/bindCore/);
		expect(() => runtime.setActiveTools([])).toThrow(/bindCore/);
		expect(() => runtime.createContext()).toThrow(/bindCore/);
	});

	it('bindCore 后：动作转发到注入实现', () => {
		const runtime = createExtensionRuntime();
		const injected = actions();
		bindCore(runtime, injected);
		runtime.setSessionName('x');
		expect(injected.setSessionName).toHaveBeenCalledWith('x');
		expect(runtime.getSessionName()).toBe('s');
	});

	it('assertActive：invalidate 前通过，之后抛（带 invalidate 的消息）', () => {
		const runtime = createExtensionRuntime();
		runtime.assertActive();
		runtime.invalidate('已 reload');
		expect(() => runtime.assertActive()).toThrow(/已 reload/);
	});

	it('trackEventBusSubscription：invalidate 时统一退订；手动取消后不再退订', () => {
		const runtime = createExtensionRuntime();
		const a = vi.fn();
		const b = vi.fn();
		runtime.trackEventBusSubscription(a)();
		runtime.trackEventBusSubscription(b);
		runtime.invalidate();
		expect(a).not.toHaveBeenCalled();   // 已手动取消
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('已失效的 runtime 上 trackEventBusSubscription 立即退订并返回空取消函数', () => {
		const runtime = createExtensionRuntime();
		runtime.invalidate();
		const unsubscribe = vi.fn();
		const cancel = runtime.trackEventBusSubscription(unsubscribe);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(() => cancel()).not.toThrow();
	});

	it('flagValues 可读写；provider / MCP / 虚拟模型字段不存在（类型层锁）', () => {
		const runtime: ExtensionRuntime = createExtensionRuntime();
		runtime.flagValues.set('k', true);
		expect(runtime.flagValues.get('k')).toBe(true);
		// @ts-expect-error 浏览器子集不声明 provider 注册（spec C11：不支持面不造 stub）
		expect(runtime.registerProvider).toBeUndefined();
		// 类型 smoke：ToolInfo/Type 引用保留（确认动作签名可被真实调用方满足）
		expect(Type.Object({}).type).toBe('object');
	});
});
