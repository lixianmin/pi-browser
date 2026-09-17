// S5 spec §3.1 / §5 Task 1：`defineExtension` 的校验与归一。
// 四类失败（name / description / parameters / execute）+ 同批（同一扩展内）重名 → 抛错；通过路径一条。
import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { defineExtension, type ExtensionToolSpec } from '../src/extensions/define';

const echoSpec = (over: Partial<ExtensionToolSpec> = {}): ExtensionToolSpec => ({
	name: 'Echo',
	description: '回显参数（测试用）',
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }),
	...over,
});

describe('defineExtension：校验', () => {
	it('扩展名缺失或全空白 → 抛错', () => {
		expect(() => defineExtension({ name: '   ' })).toThrow(/name/);
	});

	it('工具名缺失或全空白 → 抛错', () => {
		expect(() => defineExtension({ name: 'ext', tools: [echoSpec({ name: ' ' })] })).toThrow(/name/);
	});

	it('description 为空 → 抛错（模型靠它选工具）', () => {
		expect(() => defineExtension({ name: 'ext', tools: [echoSpec({ description: '  ' })] })).toThrow(/description/);
	});

	it('parameters 缺失 → 抛错', () => {
		const { parameters: _dropped, ...withoutParameters } = echoSpec();
		const spec = withoutParameters as ExtensionToolSpec;
		expect(() => defineExtension({ name: 'ext', tools: [spec] })).toThrow(/parameters/);
	});

	it('execute 不是函数 → 抛错', () => {
		const spec = echoSpec({ execute: 'nope' as unknown as ExtensionToolSpec['execute'] });
		expect(() => defineExtension({ name: 'ext', tools: [spec] })).toThrow(/execute/);
	});

	it('同一扩展内工具重名 → 抛错（信息含扩展名与工具名）', () => {
		expect(() => defineExtension({ name: 'ext', tools: [echoSpec(), echoSpec()] })).toThrow(/ext.*Echo/);
	});
});

describe('defineExtension：归一', () => {
	it('label 缺省归一为 name，显式 label 原样保留', () => {
		const defined = defineExtension({ name: 'ext', tools: [echoSpec(), echoSpec({ name: 'Ping', label: 'Ping 工具' })] });
		expect(defined.tools?.map((t) => t.label)).toEqual(['Echo', 'Ping 工具']);
	});

	it('tools 缺省归一为空数组（不留给调用方 undefined）', () => {
		expect(defineExtension({ name: 'ext' }).tools).toEqual([]);
	});

	it('通过路径：校验通过时 name / parameters / execute 原样带回（execute 是同一函数引用）', () => {
		const source = echoSpec();
		const defined = defineExtension({ name: 'ext', tools: [source] });
		expect(defined.name).toBe('ext');
		expect(defined.tools?.[0].name).toBe('Echo');
		expect(defined.tools?.[0].parameters).toBe(source.parameters);
		expect(defined.tools?.[0].execute).toBe(source.execute);
	});
});
