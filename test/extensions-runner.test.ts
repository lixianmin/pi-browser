// test/extensions-runner.test.ts —— S6 T3：宿主（ExtensionRunner）行为契约。
//
// 用假 harness/lane（spy）测：绑定是可注入的（宿主装配在 spice，不在本层），所以这里不需要真 harness。
// 覆盖：装载→注册表→两层工具面同步 / 重名后写覆盖+warn / 相位门 / appendEntry / setActiveTools / close。
import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { ExtensionRunner } from '../src/extensions/runner';
import type { ToolDefinition } from '../src/extensions/tool';

function fakes() {
	const harness = {
		hooks: { on: vi.fn(() => () => {}) },
		events: { on: vi.fn(() => () => {}) },
		setTools: vi.fn(async () => {}),
		setName: vi.fn(async () => {}),
		setLabel: vi.fn(async () => {}),
	};
	const lane = {
		setActiveTools: vi.fn(async () => {}),
		appendCustomEntry: vi.fn(async () => 'entry-1'),
		steer: vi.fn(async () => ({})),
		followUp: vi.fn(async () => ({})),
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(async () => {}),
		abort: vi.fn(async () => ({})),
		compact: vi.fn(async () => ({})),
	};
	return { harness, lane };
}

const makeRunner = (f: ReturnType<typeof fakes>) => new ExtensionRunner({
	harness: f.harness as never,
	lane: f.lane as never,
	context: BACKGROUND_CONTEXT,
	cwd: '/w',
	thinkingLevel: 'medium',
	activeTools: [],
});

const tool = (name: string): ToolDefinition => ({
	name,
	label: name,
	description: `${name} 工具`,
	parameters: Type.Object({}),
	execute: async () => ({ content: [], details: {} }),
});

describe('ExtensionRunner（宿主）', () => {
	it('装载后工具进注册表，并同步进 harness（可用集）与 lane（激活集）两层', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		await runner.load([
			{ name: 'ext-a', factory: (pi) => { pi.registerTool(tool('alpha')); pi.registerTool(tool('beta')); } },
		]);

		expect(runner.getAllRegisteredTools().map((t) => t.definition.name)).toEqual(['alpha', 'beta']);
		expect(runner.getAllRegisteredTools()[0]!.sourceInfo).toMatchObject({ source: 'ext-a', scope: 'project', path: '<extension:ext-a>' });
		expect(f.harness.setTools).toHaveBeenCalledTimes(1);
		const call0 = f.harness.setTools.mock.calls[0] as unknown as unknown[];
		expect((call0[0] as { name: string }[]).map((t) => t.name)).toEqual(['alpha', 'beta']);
		expect(call0[1]).toBe(BACKGROUND_CONTEXT);
		expect(f.lane.setActiveTools).toHaveBeenCalledWith(['alpha', 'beta'], BACKGROUND_CONTEXT);
	});

	it('同名：后写覆盖先写（对齐 pi 的 Map 语义），且只 warn 一次', async () => {
		const f = fakes();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const runner = makeRunner(f);
		await runner.load([
			{ name: 'ext-a', factory: (pi) => { pi.registerTool(tool('dup')); } },
			{ name: 'ext-b', factory: (pi) => { pi.registerTool(tool('dup')); } },
		]);

		const registered = runner.getAllRegisteredTools();
		expect(registered).toHaveLength(1);
		expect(registered[0]!.sourceInfo.source).toBe('ext-b');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String((warn.mock.calls[0] as unknown[])[0])).toContain('dup');
		warn.mockRestore();
	});

	it('注册期（扩展工厂里）调用运行期成员 → 响亮抛错，不静默用旧 context', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		await expect(runner.load([{ name: 'ext-a', factory: (pi) => { pi.setActiveTools(['x']); } }]))
			.rejects.toThrow(/注册期/);
	});

	it('appendEntry 落到 lane.appendCustomEntry（带宿主 context）', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		const apis = await runner.load([{ name: 'ext-a', factory: () => {} }]);
		apis.get('ext-a')!.appendEntry('ledger', { kind: 'checkpoint', oid: 'abc' });
		await vi.waitFor(() => expect(f.lane.appendCustomEntry).toHaveBeenCalledWith('ledger', { kind: 'checkpoint', oid: 'abc' }, BACKGROUND_CONTEXT));
	});

	it('setActiveTools 更新同步缓存并落到 lane；getActiveTools 读缓存（pi 的这两个成员是同步值）', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		const apis = await runner.load([{ name: 'ext-a', factory: () => {} }]);
		const api = apis.get('ext-a')!;
		expect(api.getActiveTools()).toEqual([]);
		api.setActiveTools(['alpha']);
		expect(api.getActiveTools()).toEqual(['alpha']);
		expect(f.lane.setActiveTools).toHaveBeenLastCalledWith(['alpha'], BACKGROUND_CONTEXT);
	});

	it('close() 之后运行期成员再次抛错（相位回落）', async () => {
		const f = fakes();
		const runner = makeRunner(f);
		const apis = await runner.load([{ name: 'ext-a', factory: () => {} }]);
		await runner.close();
		expect(() => apis.get('ext-a')!.getActiveTools()).toThrow(/注册期/);
	});
});
