// S5 spec §3.1 / §5 Task 2：`composeToolset` 合成工具集（内置 + 扩展）。
// 重名默认抛错（不静默顶掉、也不静默丢弃），`overrideBuiltins` 是唯一且必须显式声明的口子；顺序稳定。
// 产物形状 = 上游 `AgentTool[]`（= `AgentContext['tools']`，可直接交给低层 `Agent`）；要进 `AgentHarness`
// 得再过一层 `toHarnessTool`（两边 execute 签名不同，见 §3.1 与 harness-tool.ts）。
import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import type { AgentContext } from '@earendil-works/pi-agent-core';
import { BUILTIN_PROVIDER, composeToolset } from '../src/extensions/compose';
import { defineExtension, type ExtensionSpec, type ExtensionToolSpec } from '../src/extensions/define';
import { createReadTool } from '../src/tools/read-tool';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const tool = (name: string, description = `${name} 工具`): ExtensionToolSpec => ({
	name,
	description,
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: 'text', text: name }], details: undefined }),
});

const ext = (name: string, ...tools: ExtensionToolSpec[]): ExtensionSpec => defineExtension({ name, tools });

describe('composeToolset：合成与顺序', () => {
	it('内置在前、扩展按声明序追加；providerOf 记录每个工具的来源', () => {
		const { tools, providerOf } = composeToolset({
			builtin: [tool('Read'), tool('Write')],
			extensions: [ext('ext-a', tool('Alpha'), tool('Beta')), ext('ext-b', tool('Gamma'))],
		});

		expect(tools.map((t) => t.name)).toEqual(['Read', 'Write', 'Alpha', 'Beta', 'Gamma']);
		expect(providerOf).toEqual({
			Read: BUILTIN_PROVIDER,
			Write: BUILTIN_PROVIDER,
			Alpha: 'ext-a',
			Beta: 'ext-a',
			Gamma: 'ext-b',
		});
	});

	it('产物可直接赋给 AgentContext[\'tools\']，且 label 归一非空', () => {
		const { tools } = composeToolset({ builtin: [tool('Read')], extensions: [ext('ext-a', tool('Alpha'))] });
		const context: AgentContext = { systemPrompt: 'sys', messages: [], tools }; // 类型消费点：形状不匹配这里就编译不过

		expect(context.tools?.map((t) => t.name)).toEqual(['Read', 'Alpha']);
		expect(context.tools?.every((t) => typeof t.label === 'string' && t.label.length > 0)).toBe(true);
	});

	it('入参全缺省 → 空工具集（不抛错）', () => {
		expect(composeToolset()).toEqual({ tools: [], providerOf: {} });
	});

	it('内置可以是真工具工厂的产物（具体 schema 的工具与扩展声明同表共存）', () => {
		const read = createReadTool({ fs: createMemoryFileSystem() });
		const { tools, providerOf } = composeToolset({ builtin: [read], extensions: [ext('ext-a', tool('Alpha'))] });

		expect(tools.map((t) => t.name)).toEqual(['Read', 'Alpha']);
		expect(tools[0].label).toBe('Read');
		expect(providerOf.Read).toBe(BUILTIN_PROVIDER);
	});
});

describe('composeToolset：重名', () => {
	it('扩展撞内置且未声明 overrideBuiltins → 抛错，信息含冲突双方来源', () => {
		expect(() => composeToolset({ builtin: [tool('Read')], extensions: [ext('ext-a', tool('Read'))] })).toThrow(
			'工具重名："Read"：builtin 与 ext-a 都提供；要覆盖内置需把名字显式列进 overrideBuiltins',
		);
	});

	it('两个扩展撞名 → 抛错，信息含双方扩展名', () => {
		expect(() =>
			composeToolset({ extensions: [ext('ext-a', tool('Alpha')), ext('ext-b', tool('Alpha'))] }),
		).toThrow('工具重名："Alpha"：ext-a 与 ext-b 都提供');
	});

	it('overrideBuiltins 只对内置开口：两个扩展撞名仍然抛错', () => {
		expect(() =>
			composeToolset({ extensions: [ext('ext-a', tool('Alpha')), ext('ext-b', tool('Alpha'))], overrideBuiltins: ['Alpha'] }),
		).toThrow('工具重名："Alpha"：ext-a 与 ext-b 都提供');
	});

	it('内置自带重名（宿主两次塞同一个名字）→ 抛错，不静默取后者', () => {
		expect(() => composeToolset({ builtin: [tool('Read'), tool('Read')] })).toThrow('工具重名："Read"：builtin 提供了两次');
	});

	it('overrideBuiltins 显式列出 → 扩展顶掉内置，且占内置原槽位', () => {
		const { tools, providerOf } = composeToolset({
			builtin: [tool('Read', '内置 Read'), tool('Write', '内置 Write')],
			extensions: [ext('ext-a', tool('Alpha'), tool('Read', '扩展 Read'))],
			overrideBuiltins: ['Read'],
		});

		expect(tools.map((t) => t.name)).toEqual(['Read', 'Write', 'Alpha']);
		expect(tools[0].description).toBe('扩展 Read'); // 顶掉的是内置实现，不是「两份并存」
		expect(providerOf).toEqual({ Read: 'ext-a', Write: BUILTIN_PROVIDER, Alpha: 'ext-a' });
	});
});
