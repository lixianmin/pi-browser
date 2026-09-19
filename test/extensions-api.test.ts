// test/extensions-api.test.ts —— S6 T2：ToolDefinition 形状与注册期校验。
//
// 与 S5 的差别（spec §3.3）：`label` 从「可省、缺省取 name」改为 **必填**（pi 的形状）；
// `execute` 从四参改为五参（多一个 `ctx: ExtensionContext`）；`promptSnippet` / `promptGuidelines`
// 是上游字段，本仓支持（进 system prompt）。这里先锁「声明期能查清的事」——
// 四条响亮错误逐条一条用例，错误消息必须带工具名（静默失效比报错更糟，同 S5 口径）。
import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { validateToolDefinition, type ToolDefinition } from '../src/extensions/tool';

const ok = (): ToolDefinition => ({
	name: 'echo',
	label: 'Echo',
	description: '回显传入文本',
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: 'text' as const, text: 'x' }], details: {} }),
});

describe('ToolDefinition 校验（pi 形状）', () => {
	it('缺 label → 抛错并带工具名（pi 的 label 必填，不再缺省取 name）', () => {
		const { label: _label, ...rest } = ok();
		expect(() => validateToolDefinition(rest as unknown as ToolDefinition)).toThrow(/echo/);
	});

	it('缺 name → 抛错（此时没有工具名可带，用位置描述）', () => {
		expect(() => validateToolDefinition({ ...ok(), name: '  ' })).toThrow(/name/);
	});

	it('缺 description / parameters / execute 各自抛错并带工具名', () => {
		const cases: Array<[string, Partial<ToolDefinition>]> = [
			['description', { description: '   ' }],
			['parameters', { parameters: undefined as never }],
			['execute', { execute: undefined as never }],
		];
		for (const [missing, patch] of cases) {
			expect(() => validateToolDefinition({ ...ok(), ...patch }), missing).toThrow(/echo/);
		}
	});

	it('label 为空串同样拒绝（空格不算 label）', () => {
		expect(() => validateToolDefinition({ ...ok(), label: ' ' })).toThrow(/echo/);
	});

	it('通过路径不抛错（校验只读不改，execute 引用不被包装）', () => {
		const def = ok();
		expect(() => validateToolDefinition(def)).not.toThrow();
	});
});
