// test/extensions-runner.test.ts —— P3 Task 19：宿主（ExtensionRunner）换注入模型后的行为契约。
//
// 装配口径与生产一致（D4/C11）：造一份动作全是抛错 stub 的 runtime → `new ExtensionRunner(extensions, runtime, cwd)`
// → `runner.bindCore(actions, contextActions)` → `await runner.load()`。所以这里不需要假 harness/lane：
// 宿主动作就是一组 spy。
import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { ExtensionRunner } from '../src/extensions/runner';
import { createExtensionRuntime, type ExtensionActions, type ExtensionContextActions } from '../src/extensions/runtime';
import type { Extension, ExtensionAPI } from '../src/index';
import type { ToolDefinition } from '../src/extensions/tool';

/** 宿主动作（上游 `ExtensionActions` 的浏览器子集，成员逐字对齐 `runtime.ts`）。 */
function fakes() {
	const state = { sessionName: '未命名', activeTools: ['read'], thinkingLevel: 'medium' as const };
	const actions: ExtensionActions = {
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		setSessionName: vi.fn((name: string) => { state.sessionName = name; }),
		getSessionName: vi.fn(() => state.sessionName),
		setLabel: vi.fn(),
		getActiveTools: vi.fn(() => [...state.activeTools]),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn((names: string[]) => { state.activeTools = names; }),
		setModel: vi.fn(async () => true),
		getThinkingLevel: vi.fn(() => state.thinkingLevel),
		setThinkingLevel: vi.fn((level) => { state.thinkingLevel = level; }),
	};
	const model = { provider: 'anthropic', id: 'claude' } as never;
	const abort = vi.fn();
	const compact = vi.fn();
	const contextActions: ExtensionContextActions = {
		getModel: () => model,
		getSignal: () => undefined,
		abort,
		compact,
	};
	return { actions, contextActions, model, abort, compact, state };
}

/** 未 bind 的 runner（与生产同序：先造，再 bind）。 */
const makeRunner = (extensions: readonly Extension[], f: ReturnType<typeof fakes>) => {
	const runtime = createExtensionRuntime();
	const runner = new ExtensionRunner(extensions, runtime, '/w');
	return { runner, runtime };
};

const tool = (name: string): ToolDefinition => ({
	name,
	label: name,
	description: `${name} 工具`,
	parameters: Type.Object({}),
	execute: async () => ({ content: [], details: {} }),
});

const ext = (name: string, factory: (pi: ExtensionAPI) => void): Extension => ({ name, factory });

describe('ExtensionRunner（宿主，注入模型）', () => {
	it('构造 + bindCore + load 后：工具进注册表，宿主自己取（runner 不再 sync 进 harness/lane）', async () => {
		const f = fakes();
		const { runner, runtime } = makeRunner([ext('ext-a', (pi) => {
			pi.registerTool(tool('alpha'));
			pi.registerTool(tool('beta'));
		})], f);
		runner.bindCore(f.actions, f.contextActions);
		await runner.load();

		expect(runner.getAllRegisteredTools().map((t) => t.definition.name)).toEqual(['alpha', 'beta']);
		expect(runner.getAllRegisteredTools()[0]!.sourceInfo)
			.toMatchObject({ source: 'ext-a', scope: 'project', path: '<extension:ext-a>' });
		expect(runner.getToolDefinition('alpha')?.name).toBe('alpha');
		expect(runner.getToolDefinition('nope')).toBeUndefined();
		// runtime 上的宿主动作已被 bindCore 换掉（不再是抛错 stub）
		expect(runtime.getSessionName()).toBe('未命名');
	});

	it('bindCore 之前调用运行期成员 → 响亮抛错（loader 的 stub 就是那道闸）', async () => {
		const f = fakes();
		const { runtime } = makeRunner([], f);
		expect(() => runtime.getSessionName()).toThrow(/bindCore/);
		expect(() => runtime.createContext()).toThrow(/bindCore/);
	});

	it('bindCore 传 providerActions → 抛（不支持面，不造 stub）', () => {
		const f = fakes();
		const { runner } = makeRunner([], f);
		expect(() => runner.bindCore(f.actions, f.contextActions, { registerProvider: () => {} }))
			.toThrow(/providerActions/);
	});

	it('同名：后写覆盖先写（对齐 pi 的 Map 语义），且只 warn 一次', async () => {
		const f = fakes();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { runner } = makeRunner([
			ext('ext-a', (pi) => { pi.registerTool(tool('dup')); }),
			ext('ext-b', (pi) => { pi.registerTool(tool('dup')); }),
		], f);
		runner.bindCore(f.actions, f.contextActions);
		await runner.load();

		const registered = runner.getAllRegisteredTools();
		expect(registered).toHaveLength(1);
		expect(registered[0]!.sourceInfo.source).toBe('ext-b');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String((warn.mock.calls[0] as unknown[])[0])).toContain('dup');
		warn.mockRestore();
	});

	it('注册期（扩展工厂里）调用运行期成员 → 响亮抛错，不静默用旧 context', async () => {
		const f = fakes();
		const { runner } = makeRunner([ext('ext-a', (pi) => { pi.setActiveTools(['x']); })], f);
		runner.bindCore(f.actions, f.contextActions);
		await expect(runner.load()).rejects.toThrow(/注册期/);
		expect(f.actions.setActiveTools).not.toHaveBeenCalled();
	});

	it('api 成员全部转发到宿主动作（不再有 lane/harness 落点）', async () => {
		const f = fakes();
		const { runner } = makeRunner([ext('ext-a', () => {})], f);
		runner.bindCore(f.actions, f.contextActions);
		const apis = await runner.load();
		const api = apis.get('ext-a')!;

		api.appendEntry('ledger', { kind: 'checkpoint', oid: 'abc' });
		expect(f.actions.appendEntry).toHaveBeenCalledWith('ledger', { kind: 'checkpoint', oid: 'abc' });
		api.setActiveTools(['alpha']);
		expect(f.actions.setActiveTools).toHaveBeenCalledWith(['alpha']);
		expect(api.getActiveTools()).toEqual(['alpha']);       // 同步读宿主动作
		api.setSessionName('新名字');
		expect(f.actions.setSessionName).toHaveBeenCalledWith('新名字');
		expect(api.getSessionName()).toBe('新名字');
		api.setThinkingLevel('high');
		expect(f.actions.getThinkingLevel()).toBe('high');
		expect(await api.setModel({ provider: 'anthropic', id: 'claude' } as never)).toBe(true);
		api.sendUserMessage('hi', { deliverAs: 'followUp' });
		expect(f.actions.sendUserMessage).toHaveBeenCalledWith('hi', { deliverAs: 'followUp' });
		api.setLabel('e1', '标签');
		expect(f.actions.setLabel).toHaveBeenCalledWith('e1', '标签');
	});

	it('ctx 的 4 个成员由 contextActions 取值；bindCore 之前拿 ctx → 抛', () => {
		const f = fakes();
		const { runner: bare } = makeRunner([], f);
		expect(() => bare.createContext()).toThrow(/bindCore/);

		const { runner } = makeRunner([], f);
		runner.bindCore(f.actions, f.contextActions);
		const ctx = runner.createContext();
		expect(ctx.cwd).toBe('/w');
		expect(ctx.model).toBe(f.model);
		expect(ctx.signal).toBeUndefined();
		ctx.abort();
		ctx.compact({ customInstructions: '省点' });
		expect(f.abort).toHaveBeenCalledTimes(1);
		expect(f.compact).toHaveBeenCalledWith({ customInstructions: '省点' });
	});

	it('ctx 的 signal 优先取本次调用的信号（U13：取消必须显式转发）', () => {
		const f = fakes();
		const { runner } = makeRunner([], f);
		runner.bindCore(f.actions, f.contextActions);
		const ac = new AbortController();
		expect(runner.createContext(ac.signal).signal).toBe(ac.signal);
	});

	it('close() 之后锁死：api 运行期成员与 ctx 都抛', async () => {
		const f = fakes();
		const { runner } = makeRunner([ext('ext-a', () => {})], f);
		runner.bindCore(f.actions, f.contextActions);
		const apis = await runner.load();
		const ctx = runner.createContext();
		await runner.close();

		expect(() => apis.get('ext-a')!.getActiveTools()).toThrow(/注册期/);
		expect(() => ctx.cwd).toThrow();
	});

	it('invalidate 后事件总线订阅被退订（runtime 统一退订）', async () => {
		const f = fakes();
		const { runner } = makeRunner([ext('ext-a', (pi) => { pi.events.on('tick', () => { hits.push(1); }); })], f);
		const hits: number[] = [];
		runner.bindCore(f.actions, f.contextActions);
		await runner.load();

		await runner.emitEventBus('tick', { n: 1 });
		expect(hits).toEqual([1]);
		runner.invalidate();
		await runner.emitEventBus('tick', { n: 2 });
		expect(hits).toEqual([1]);
	});

	it('handler 抛错不外泄：走 onError 上报，同事件的其他 handler 照跑', async () => {
		const f = fakes();
		const { runner } = makeRunner([
			ext('bad', () => {}),
			ext('ext-a', (pi) => { pi.on('agent_start', () => { throw new Error('boom'); }); }),
			ext('ext-b', (pi) => { pi.on('agent_start', () => { hits.push('b'); }); }),
		], f);
		const hits: string[] = [];
		const errors: unknown[] = [];
		runner.bindCore(f.actions, f.contextActions);
		runner.onError((e) => errors.push(e));
		await runner.load();

		await runner.emit({ type: 'agent_start' });
		expect(hits).toEqual(['b']);
		expect(errors).toEqual([{ extensionPath: '<extension:ext-a>', event: 'agent_start', error: 'boom', stack: expect.any(String) }]);
	});
});
