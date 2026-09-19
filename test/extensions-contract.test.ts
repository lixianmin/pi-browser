// test/extensions-contract.test.ts —— S6 spec §4.1：名单对照（核心护栏）。
//
// 为什么要有这个文件：S5 的教训是「自造了一套同目的、名字不同的扩展面」。本测试把上游名字
// **逐字抄下来**（不 import 上游包——pi-browser 是浏览器仓，不该依赖 CLI 包），断言三件事：
//   ① 我们抄的名单与硬编码的上游名单逐字一致（上游升级时这里会红，逼人重新对照）；
//   ② 「支持 / 不支持」两类恰好覆盖全部成员，且不重叠（不许有成员两边都不算）；
//   ③ 标「不支持」的成员在公开面上**没有同名替代物**（防再造一个「差不多」的名字）。
import { describe, it, expect } from 'vitest';
import * as api from '../src/index';
import type { ExtensionEventMap } from '../src/extensions/api';
import {
	EXTENSION_API_MEMBERS, EXTENSION_CONTEXT_MEMBERS, EXTENSION_EVENTS,
	SUPPORTED_API_MEMBERS, SUPPORTED_CONTEXT_MEMBERS, SUPPORTED_EVENTS,
	UNSUPPORTED_API_MEMBERS, UNSUPPORTED_CONTEXT_MEMBERS, UNSUPPORTED_EVENTS,
} from '../src/extensions/contract';

/** 上游 @earendil-works/pi-coding-agent@… 的 ExtensionAPI 成员（含 on） */
const PI_API_MEMBERS = [
	'on', 'registerTool', 'registerCommand', 'registerShortcut', 'registerFlag', 'getFlag',
	'registerMessageRenderer', 'registerMarkdownTransformer', 'registerEntryRenderer',
	'sendMessage', 'sendUserMessage', 'appendEntry', 'setSessionName', 'getSessionName', 'setLabel',
	'exec', 'getActiveTools', 'getAllTools', 'setActiveTools', 'getCommands',
	'setModel', 'getThinkingLevel', 'setThinkingLevel', 'registerProvider', 'unregisterProvider', 'events',
];
/** 上游 ExtensionAPI.on 的事件名（36 个，逐字） */
const PI_EVENTS = [
	'project_trust', 'resources_discover', 'session_start', 'session_info_changed', 'session_before_switch',
	'session_before_fork', 'session_before_compact', 'session_compact', 'session_compact_failed',
	'session_shutdown', 'session_before_tree', 'session_tree', 'context', 'input', 'before_provider_request',
	'before_provider_headers', 'after_provider_response', 'before_agent_start', 'agent_start', 'agent_end',
	'agent_settled', 'ui_prompt_start', 'ui_prompt_end', 'turn_start', 'turn_end', 'message_start',
	'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
	'model_select', 'thinking_level_select', 'tool_call', 'tool_result', 'user_bash',
];
/** 上游 ExtensionContext 成员（17 个，逐字） */
const PI_CONTEXT_MEMBERS = [
	'ui', 'mode', 'hasUI', 'cwd', 'sessionManager', 'modelRegistry', 'model', 'scopedModels', 'isIdle',
	'isProjectTrusted', 'signal', 'abort', 'hasPendingMessages', 'shutdown', 'getContextUsage', 'compact', 'getSystemPrompt',
];

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('名单不变量（上游逐字对照）', () => {
	it('抄下来的三张名单与上游逐字一致', () => {
		expect(sorted(EXTENSION_API_MEMBERS)).toEqual(sorted(PI_API_MEMBERS));
		expect(sorted(EXTENSION_EVENTS)).toEqual(sorted(PI_EVENTS));
		expect(sorted(EXTENSION_CONTEXT_MEMBERS)).toEqual(sorted(PI_CONTEXT_MEMBERS));
	});

	it('支持 / 不支持 两类恰好覆盖全部成员，且互不重叠', () => {
		const members = [...SUPPORTED_API_MEMBERS, ...UNSUPPORTED_API_MEMBERS];
		expect(sorted(members)).toEqual(sorted(PI_API_MEMBERS));
		expect(new Set(members).size).toBe(members.length);

		const events = [...Object.keys(SUPPORTED_EVENTS), ...UNSUPPORTED_EVENTS];
		expect(sorted(events)).toEqual(sorted(PI_EVENTS));
		expect(new Set(events).size).toBe(events.length);

		const ctx = [...SUPPORTED_CONTEXT_MEMBERS, ...UNSUPPORTED_CONTEXT_MEMBERS];
		expect(sorted(ctx)).toEqual(sorted(PI_CONTEXT_MEMBERS));
		expect(new Set(ctx).size).toBe(ctx.length);
	});

	it('标「不支持」的成员在公开面上不得有同名替代物', () => {
		const surface = api as Record<string, unknown>;
		for (const name of UNSUPPORTED_API_MEMBERS) expect(surface[name], name).toBeUndefined();
	});

	it('事件类型表的键集合与「支持」名单一致（两个方向都钉住）', () => {
		type MapKeys = keyof ExtensionEventMap;
		type ContractKeys = keyof typeof SUPPORTED_EVENTS;
		// 任一边多出/漏掉一个名字，下面的赋值就红——错误信息里直接列出差异的名字。
		// （`SUPPORTED_EVENTS` 一旦被标注成 `Record<string, string>`，`ContractKeys` 会退化成 `string`，
		//  这条断言就变成恒假，所以它同时钉住了「键必须是字面量联合」这件事。）
		const sameKeys: [MapKeys] extends [ContractKeys]
			? [ContractKeys] extends [MapKeys] ? true : { 名单多出: Exclude<ContractKeys, MapKeys> }
			: { 类型表多出: Exclude<MapKeys, ContractKeys> } = true;
		expect(sameKeys).toBe(true);
	});
});
