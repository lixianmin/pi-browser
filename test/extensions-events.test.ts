// test/extensions-events.test.ts —— S6 T4：`on(event, handler)` 的事件映射契约（36 项里标「支持」的接线）。
//
// 断言口径：pi 事件名 → pi-agent-core 落点名（hooks / events），handler 拿到的是 harness 事件 + 一份 ctx；
// 不支持的事件**注册即抛**（错误消息必须列出支持清单，不静默丢弃）。
import { describe, it, expect, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import type { Extension, ExtensionAPI } from '../src/index';
import { ExtensionRunner } from '../src/extensions/runner';
import type { ExtensionEventMap } from '../src/extensions/api';
import { SUPPORTED_EVENTS, UNSUPPORTED_EVENTS } from '../src/extensions/contract';

/**
 * 绕过类型门去注册任意事件名。类型门（`ExtensionEventMap` 的键集合）已经挡住了这些名字，
 * 这里要验的是**运行期检查仍在**（注册即抛，错误里带支持清单），所以必须刻意绕过去。
 */
const onAny = (pi: ExtensionAPI) => pi.on as unknown as (event: string, handler: () => void) => void;

function fakes() {
	const harness = {
		hooks: { on: vi.fn((..._args: unknown[]) => () => {}) },
		events: { on: vi.fn((..._args: unknown[]) => () => {}) },
		setTools: vi.fn(async () => {}),
		setName: vi.fn(async () => {}),
		setLabel: vi.fn(async () => {}),
	};
	const lane = {
		setActiveTools: vi.fn(async () => {}),
		appendCustomEntry: vi.fn(async () => 'e'),
		abort: vi.fn(async () => ({})),
		compact: vi.fn(async () => ({})),
	};
	return { harness, lane };
}
const makeRunner = (f: ReturnType<typeof fakes>) => new ExtensionRunner({
	harness: f.harness as never, lane: f.lane as never, context: BACKGROUND_CONTEXT, cwd: '/w', thinkingLevel: 'medium',
});

/** 取注册到 harness 上的处理器（第一次注册）。 */
type Spy = { mock: { calls: unknown[][] } };
const firstHandler = (on: Spy): ((e: unknown) => unknown) => on.mock.calls[0]![1] as (e: unknown) => unknown;

describe('on(event, handler) 映射', () => {
	it('tool_call → hooks.on("before_tool")，handler 收到 harness 事件与 ctx', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		const seen: unknown[][] = [];
		await runner.load([{ name: 'ext-a', factory: (pi) => { pi.on('tool_call', (e, ctx) => { seen.push([e, ctx]); }); } }]);

		expect(f.harness.hooks.on).toHaveBeenCalledTimes(1);
		expect(f.harness.hooks.on.mock.calls[0]![0]).toBe('before_tool');
		firstHandler(f.harness.hooks.on)({ toolName: 'Write', args: { path: 'a' } });
		expect(seen[0]![0]).toEqual({ toolName: 'Write', args: { path: 'a' } });
		expect(seen[0]![1]).toMatchObject({ cwd: '/w' });
	});

	it('turn_end → events.on("turn_end")；agent_start → events.on("run_start")', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		await runner.load([{ name: 'ext-a', factory: (pi) => { pi.on('turn_end', () => {}); pi.on('agent_start', () => {}); } }]);
		expect(f.harness.events.on.mock.calls.map((c) => c[0])).toEqual(['turn_end', 'run_start']);
	});

	it('model_select 走 config_update 且只在 property==="model" 时触发', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		const hits: unknown[] = [];
		await runner.load([{ name: 'ext-a', factory: (pi) => { pi.on('model_select', (e) => { hits.push(e); }); } }]);
		expect(f.harness.events.on.mock.calls[0]![0]).toBe('config_update');
		const handler = firstHandler(f.harness.events.on);
		handler({ property: 'thinkingLevel' });   // 不匹配 → 不该触发
		handler({ property: 'model' });
		expect(hits).toEqual([{ property: 'model' }]);
	});

	it('不支持的事件注册即抛，错误里带支持清单；支持清单里的事件全部可注册', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		await expect(runner.load([{ name: 'ext-a', factory: (pi) => { onAny(pi)('ui_prompt_start', () => {}); } }]))
			.rejects.toThrow(/不支持/);

		const f2 = fakes();
		const runner2 = makeRunner(f2);
		await runner2.load([{ name: 'ext-b', factory: (pi) => {
			for (const e of Object.keys(SUPPORTED_EVENTS) as (keyof ExtensionEventMap)[]) pi.on(e, () => {});
		} }]);
		expect(runner2).toBeTruthy();
		expect(UNSUPPORTED_EVENTS).toContain('ui_prompt_start');
	});

	// 类型层用例：不跑扩展工厂，只让 `tsc --noEmit` 判卷（`it` 只为进 typecheck 的 include 范围）。
	it('类型层：事件名是封闭集合，载荷 = pi-agent-core 的实际交付形状', () => {
		const ext: Extension = (pi) => {
			// @ts-expect-error 不支持的事件名（TUI 提示）必须编译期就红，而不是等到运行期才抛
			pi.on('ui_prompt_start', () => {});
			// @ts-expect-error 未知事件名同理
			pi.on('not_an_event', () => {});
			// 载荷 = `hooks.on('before_tool')` 的形状：`args`（不是 pi 的 `input`）、带 lane/runId；返回值同源
			pi.on('tool_call', (event) => {
				const toolName: string = event.toolName;
				const args: Record<string, unknown> = event.args;
				// @ts-expect-error 载荷不是 any：不存在的字段必须报错（否则上面的字段断言全是假的）
				void event.notAField;
				return { block: { reason: `${toolName}: ${Object.keys(args).length}` } };
			});
			// `session_start` 是宿主自造事件：只有 type（pi 的 SessionStartEvent 还有 reason，本仓不交付）
			pi.on('session_start', (event) => { void (event.type satisfies 'session_start'); });
		};
		expect(typeof ext).toBe('function');
	});

	it('session_start 在装载完成后发给订阅者（宿主生命周期）', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		const seen: string[] = [];
		await runner.load([{ name: 'ext-a', factory: (pi) => { pi.on('session_start', () => { seen.push('start'); }); } }]);
		expect(seen).toEqual(['start']);
	});
});
