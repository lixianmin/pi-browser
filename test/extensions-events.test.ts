// test/extensions-events.test.ts —— P3 Task 19：25 条「支持」事件的**逐路由触发**契约（spec R6）。
//
// R6 是 P3 里最容易「看起来对但其实没接上」的地方，所以断言口径是**每条事件都真的被触发一次**，
// 不是「注册成功就算」。触发方式 = 宿主调用的那个 emit 入口（通用 `emit` 或具名 `emitXxx`），
// 触发后断言 handler 收到（载荷 + 一份 ctx）。
//
// 载荷的**形状**由 `test/extensions-events-types.test.ts` 对着上游 `.d.ts` 逐字对照；本文件只管接线，
// 所以触发载荷用最小合法值（`as never` 绕过联合分支的必填字段），不重复验证类型。
import { describe, it, expect, vi } from 'vitest';
import { ExtensionRunner } from '../src/extensions/runner';
import { createExtensionRuntime, type ExtensionActions, type ExtensionContextActions } from '../src/extensions/runtime';
import type { Extension, ExtensionAPI } from '../src/index';
import type { ExtensionEventMap } from '../src/extensions/api';
import { SUPPORTED_EVENTS, UNSUPPORTED_EVENTS } from '../src/extensions/contract';

const actions: ExtensionActions = {
	sendUserMessage: vi.fn(), appendEntry: vi.fn(),
	setSessionName: vi.fn(), getSessionName: () => '未命名', setLabel: vi.fn(),
	getActiveTools: () => [], getAllTools: () => [], setActiveTools: vi.fn(),
	setModel: vi.fn(async () => true), getThinkingLevel: () => 'medium', setThinkingLevel: vi.fn(),
};
const contextActions: ExtensionContextActions = {
	getModel: () => undefined, getSignal: () => undefined, abort: vi.fn(), compact: vi.fn(),
};

/** 造一个已 bindCore 的 runner（工厂里把订阅挂上）。 */
async function loaded(factory: (pi: ExtensionAPI) => void) {
	const runtime = createExtensionRuntime();
	const runner = new ExtensionRunner([{ name: 'ext-a', factory }] as readonly Extension[], runtime, '/w');
	runner.bindCore(actions, contextActions);
	await runner.load();
	return runner;
}

const userMessage = { role: 'user', content: 'hi', timestamp: 0 } as never;
const assistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'yo' }], api: '', provider: '', model: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } as never;
const boundaryPreview = { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true } as never;

/** 通用 emit 的最小触发载荷（联合里挑一组字段，运行时只关心 type 路由）。 */
const GENERIC: Record<string, unknown> = {
	agent_start: {},
	agent_end: { messages: [assistantMessage] },
	turn_start: { turnIndex: 0, timestamp: 0 },
	message_start: { message: userMessage },
	message_update: { message: assistantMessage, assistantMessageEvent: { type: 'text_delta', delta: 'y' } },
	session_compact: { compactionEntry: { id: 'e', parentId: null, timestamp: '', type: 'compaction', summary: 's', firstKeptEntryId: 'e', tokensBefore: 1 }, fromExtension: false, reason: 'manual', willRetry: false },
	session_tree: { newLeafId: null, oldLeafId: null },
	session_start: { reason: 'startup' },
	session_shutdown: { reason: 'quit' },
	model_select: { model: { provider: 'anthropic', id: 'claude' }, previousModel: undefined, source: 'set' },
	thinking_level_select: { level: 'high', previousLevel: 'medium' },
	after_provider_response: { status: 200, headers: {} },
};

/** 具名 emit 的触发动作（宿主在对应时机这样调）。 */
const DEDICATED: Record<string, (runner: ExtensionRunner) => Promise<void>> = {
	context: (r) => r.emitContext([userMessage]).then(() => undefined),
	before_agent_start: (r) => r.emitBeforeAgentStart('hi', undefined, { cwd: '/w' }, () => 'SYSTEM').then(() => undefined),
	tool_execution_start: (r) => r.emit({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'read', args: {} }).then(() => undefined),
	tool_execution_update: (r) => r.emit({ type: 'tool_execution_update', toolCallId: 'c', toolName: 'read', args: {}, partialResult: {} }).then(() => undefined),
	tool_execution_end: (r) => r.emit({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'read', result: {}, isError: false }).then(() => undefined),
	session_before_compact: (r) => r.emit({ type: 'session_before_compact', preparation: { firstKeptEntryId: 'e', messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 1, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } }, branchEntries: [], reason: 'manual', willRetry: false, signal: new AbortController().signal }).then(() => undefined),
	session_before_tree: (r) => r.emit({ type: 'session_before_tree', preparation: { targetId: 't', oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false }, signal: new AbortController().signal }).then(() => undefined),
	turn_end: (r) => r.emitBoundary(
		{ type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [], messageEntryId: 'e', toolResultEntryIds: [], outcome: 'completed' },
		async () => boundaryPreview,
	).then(() => undefined),
	tool_call: (r) => r.emitToolCall({ type: 'tool_call', toolCallId: 'c', toolName: 'custom', input: {} }).then(() => undefined),
	tool_result: (r) => r.emitToolResult({ type: 'tool_result', toolCallId: 'c', toolName: 'custom', input: {}, content: [], details: {}, isError: false }).then(() => undefined),
	message_end: (r) => r.emitMessageEnd({ type: 'message_end', message: assistantMessage }).then(() => undefined),
	before_provider_request: (r) => r.emitBeforeProviderRequest({ model: 'claude' }).then(() => undefined),
	before_provider_headers: (r) => r.emitBeforeProviderHeaders({ 'x-trace': '1' }).then(() => undefined),
};

/** 25 条支持事件的触发入口总表（通用 13 + 具名 12）。 */
const TRIGGERS: Record<string, (runner: ExtensionRunner) => Promise<void>> = {
	...Object.fromEntries(Object.keys(GENERIC).map((name) => [
		name,
		(runner: ExtensionRunner) => runner.emit({ type: name, ...(GENERIC[name] as object) } as never).then(() => undefined),
	])),
	...DEDICATED,
};

const onAny = (pi: ExtensionAPI) => pi.on as unknown as (event: string, handler: () => void) => void;

describe('on(event, handler) 逐路由触发（spec R6）', () => {
	const names = Object.keys(SUPPORTED_EVENTS);

	it('触发表覆盖全部 25 条支持事件（漏一条就红）', () => {
		expect(Object.keys(TRIGGERS).sort()).toEqual([...names].sort());
		expect(names).toHaveLength(25);
	});

	it.each(names)('%s：触发一次 → handler 被调用，且拿到载荷与 ctx', async (name) => {
		const hits: Array<[unknown, { cwd: string }]> = [];
		const runner = await loaded((pi) => {
			pi.on(name as keyof ExtensionEventMap, (event, ctx) => { hits.push([event, ctx]); });
		});
		expect(runner.hasHandlers(name)).toBe(true);

		await TRIGGERS[name]!(runner);

		expect(hits).toHaveLength(1);
		expect((hits[0]![0] as { type: string }).type).toBe(name);
		expect(hits[0]![1]).toMatchObject({ cwd: '/w' });
	});

	it('没有订阅者时触发不报错，hasHandlers 为 false', async () => {
		const runner = await loaded(() => {});
		expect(runner.hasHandlers('agent_start')).toBe(false);
		await TRIGGERS.agent_start!(runner);
	});
});

describe('emit 家族的结果语义（照抄上游）', () => {
	it('tool_call：block 短路（后面的 handler 不再跑）', async () => {
		const seen: string[] = [];
		const runner = await loaded((pi) => {
			pi.on('tool_call', () => { seen.push('a'); return { block: true, reason: '不行' }; });
			pi.on('tool_call', () => { seen.push('b'); });
		});
		const result = await runner.emitToolCall({ type: 'tool_call', toolCallId: 'c', toolName: 'custom', input: {} });
		expect(seen).toEqual(['a']);
		expect(result).toEqual({ block: true, reason: '不行' });
	});

	it('tool_result：合并改写；换 content 而不换 structuredContent 时丢弃后者', async () => {
		const runner = await loaded((pi) => {
			pi.on('tool_result', () => ({ content: [{ type: 'text' as const, text: '改过' }] }));
		});
		const result = await runner.emitToolResult({
			type: 'tool_result', toolCallId: 'c', toolName: 'custom', input: {},
			content: [{ type: 'text' as const, text: '原始' }], details: {}, structuredContent: { a: 1 }, isError: false,
		});
		// `details` 没被改就原样带出（上游：返回的是合并后事件的快照，不是「只含改过的字段」）
		expect(result).toEqual({ content: [{ type: 'text', text: '改过' }], details: {}, structuredContent: undefined, isError: false, usage: undefined });
	});

	it('message_end：角色必须一致，不一致时报错并忽略该次替换', async () => {
		const errors: unknown[] = [];
		const runner = await loaded((pi) => {
			pi.on('message_end', () => ({ message: { role: 'user', content: '偷换', timestamp: 0 } as never }));
		});
		runner.onError((e) => errors.push(e));
		const message = { role: 'assistant', content: [], timestamp: 0 } as never;
		expect(await runner.emitMessageEnd({ type: 'message_end', message })).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect((errors[0] as { error: string }).error).toContain('same role');
	});

	it('before_provider_request：返回非 undefined 才替换（后写覆盖先写）', async () => {
		const runner = await loaded((pi) => {
			pi.on('before_provider_request', () => '第一个');
			pi.on('before_provider_request', (event) => (event.payload === '第一个' ? '第二个' : '不改'));
		});
		expect(await runner.emitBeforeProviderRequest('原样')).toBe('第二个');
	});

	it('before_provider_headers：原地改 headers，返回值被忽略', async () => {
		const headers: Record<string, string | null> = { keep: '1' };
		const runner = await loaded((pi) => {
			pi.on('before_provider_headers', (event) => {
				(event.headers as Record<string, unknown>)['x-added'] = 'yes';
				(event.headers as Record<string, unknown>).keep = null;
				// 返回值被忽略（handler 签名也不声明结果）
				return undefined;
			});
		});
		const result = await runner.emitBeforeProviderHeaders(headers as never);
		expect(result).toBe(headers);
		expect(headers).toEqual({ keep: null, 'x-added': 'yes' });
	});

	it('before_agent_start：后一个 handler 看到前一个的 system prompt 覆盖', async () => {
		const seen: string[] = [];
		const runner = await loaded((pi) => {
			pi.on('before_agent_start', () => ({ systemPrompt: '覆盖后的' }));
			pi.on('before_agent_start', (event) => { seen.push(event.systemPrompt); });
		});
		const result = await runner.emitBeforeAgentStart('hi', undefined, { cwd: '/w' }, (options) => options.forceSystemPrompt ?? '默认');
		expect(seen).toEqual(['覆盖后的']);
		expect(result.systemPromptOptions.forceSystemPrompt).toBe('覆盖后的');
	});

	it('context：handler 只看不含 system 的会话，换完列表后 system 消息回到头部', async () => {
		const seenRoles: string[][] = [];
		const runner = await loaded((pi) => {
			pi.on('context', (event) => {
				seenRoles.push(event.messages.map((m) => m.role));
				return { messages: event.messages.slice(1) };
			});
		});
		const system = { role: 'system', content: '提示词', timestamp: 0 } as never;
		const out = await runner.emitContext([system, userMessage, assistantMessage]);
		expect(seenRoles).toEqual([['user', 'assistant']]);
		// 头部 system 消息由重放重建（内容/工具状态保住，引用不是同一个对象——上游同款）
		expect(out[0]).toMatchObject({ role: 'system', content: '提示词' });
		expect(out).toHaveLength(2);
	});

	// 终审 bug-c：上游 normalizeBuildSystemPromptOptions 的 selectedTools 缺省是**四个核心工具**，
	// 且所有集合字段都拷贝（上游注释：「mutable, collection-complete shape exposed to extensions」）。
	// 缺省给 [] 会让宿主渲染的 system prompt 少掉它们的规则段；按引用则扩展能就地改宿主对象并跨轮次残留。
	it('before_agent_start：systemPromptOptions 缺省含四个核心工具，且集合是拷贝（改不到宿主对象）', async () => {
		const seen: Array<{ selectedTools: string[]; options: unknown }> = [];
		const runner = await loaded((pi) => {
			pi.on('before_agent_start', (event) => {
				seen.push({ selectedTools: [...event.systemPromptOptions.selectedTools], options: event.systemPromptOptions });
				// 原地改：若上游那份没拷贝，这里会改到宿主传入的对象
				event.systemPromptOptions.selectedTools.push('injected');
				event.systemPromptOptions.sections['hacked'] = 'yes';
			});
		});
		const hostSections: Record<string, string> = { mine: '1' };
		const hostSkills = [{ name: 'pdf', description: 'd', filePath: '/s', baseDir: '/s', sourceInfo: { path: '/s', source: 'local', scope: 'temporary', origin: 'top-level' }, disableModelInvocation: false }];
		const result = await runner.emitBeforeAgentStart('hi', undefined,
			{ cwd: '/w', sections: hostSections, skills: hostSkills as never }, () => 'S');
		expect(seen[0]!.selectedTools).toEqual(['read', 'bash', 'edit', 'write']);
		expect(hostSections).toEqual({ mine: '1' });                       // 宿主对象没被改
		expect(hostSkills).toHaveLength(1);
		expect(result.systemPromptOptions.selectedTools).toContain('injected');   // 改到的是拷贝
	});

	it('turn_end 边界：草稿可替换、continue 可置位；重算抛错 → valid:false', async () => {
		const runner = await loaded((pi) => {
			pi.on('turn_end', () => ({ entries: [{ type: 'custom' as const, customType: 'ledger' }], continue: true }));
		});
		const ok = await runner.emitBoundary(
			{ type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [], messageEntryId: 'e', toolResultEntryIds: [], outcome: 'completed' },
			async () => boundaryPreview,
		);
		expect(ok).toEqual({ entries: [{ type: 'custom', customType: 'ledger' }], continue: true, context: boundaryPreview, valid: true });

		const broken = await loaded((pi) => { pi.on('turn_end', () => ({ entries: [{ type: 'custom' as const, customType: 'x' }] })); });
		const bad = await broken.emitBoundary(
			{ type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [], messageEntryId: 'e', toolResultEntryIds: [], outcome: 'completed' },
			async (entries) => { if (entries.length > 0) throw new Error('草稿非法'); return boundaryPreview; },
		);
		expect(bad.valid).toBe(false);
		expect(bad.entries).toEqual([]);
	});

	// 终审 p3-A1 的覆盖缺口：只有通用 emit 测了「handler 抛错 → emitError 且后续 handler 照跑」，
	// 其余 6 个具名入口都没测。表驱动逐入口钉：先注册一个必抛的 handler，再注册一个记名的，
	// 断言「报了 1 条 error + 记名那个照跑」。
	it.each([
		['context', (r: ExtensionRunner) => r.emitContext([userMessage])],
		['tool_result', (r: ExtensionRunner) => r.emitToolResult({ type: 'tool_result', toolCallId: 'c', toolName: 'custom', input: {}, content: [], details: {}, isError: false })],
		['message_end', (r: ExtensionRunner) => r.emitMessageEnd({ type: 'message_end', message: assistantMessage })],
		['before_provider_request', (r: ExtensionRunner) => r.emitBeforeProviderRequest({ n: 1 })],
		['before_provider_headers', (r: ExtensionRunner) => r.emitBeforeProviderHeaders({ a: '1' })],
		['before_agent_start', (r: ExtensionRunner) => r.emitBeforeAgentStart('hi', undefined, { cwd: '/w' }, () => 'S')],
		['turn_end', (r: ExtensionRunner) => r.emitBoundary(
			{ type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [], messageEntryId: 'e', toolResultEntryIds: [], outcome: 'completed' },
			async () => boundaryPreview,
		)],
	] as const)('%s：handler 抛错 → emitError 上报，不外泄，后续 handler 照跑', async (event, fire) => {
		const seen: string[] = [];
		const runner = await loaded((pi) => {
			pi.on(event, () => { throw new Error('boom'); });
			pi.on(event, () => { seen.push('after'); });
		});
		const errors: unknown[] = [];
		runner.onError((e) => errors.push(e));
		await fire(runner);
		expect(errors).toHaveLength(1);
		expect((errors[0] as { error: string }).error).toBe('boom');
		expect(seen).toEqual(['after']);
	});

	it('emitToolCall：handler 抛错直接冒泡给宿主（照抄上游：阻止/放行是同一条同步决策链）', async () => {
		const runner = await loaded((pi) => {
			pi.on('tool_call', () => { throw new Error('boom'); });
		});
		await expect(runner.emitToolCall({ type: 'tool_call', toolCallId: 'c', toolName: 'custom', input: {} }))
			.rejects.toThrow('boom');
	});

	it('session_before_*：cancel 短路（后跑的 handler 不再执行）', async () => {
		const seen: string[] = [];
		const runner = await loaded((pi) => {
			pi.on('session_before_tree', () => { seen.push('a'); return { cancel: true }; });
			pi.on('session_before_tree', () => { seen.push('b'); });
		});
		const result = await runner.emit({
			type: 'session_before_tree',
			preparation: { targetId: 't', oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false },
			signal: new AbortController().signal,
		});
		expect(seen).toEqual(['a']);
		expect(result).toEqual({ cancel: true });
	});
});

describe('不支持的事件与类型门', () => {
	it('不支持的事件注册即抛，错误里带支持清单', async () => {
		await expect(loaded((pi) => { onAny(pi)('ui_prompt_start', () => {}); })).rejects.toThrow(/不支持/);
		expect(UNSUPPORTED_EVENTS).toContain('ui_prompt_start');
	});

	it('未知事件名同样报「未知事件名」（与「不支持」区分）', async () => {
		await expect(loaded((pi) => { onAny(pi)('not_an_event', () => {}); })).rejects.toThrow(/未知事件名/);
	});

	// 类型层用例：不跑扩展工厂，只让 `tsc --noEmit` 判卷（`it` 只为进 typecheck 的 include 范围）。
	it('类型层：事件名是封闭集合，载荷 = 上游事件的形状', () => {
		const e: Extension = (pi) => {
			// @ts-expect-error 不支持的事件名（TUI 提示）必须编译期就红
			pi.on('ui_prompt_start', () => {});
			// @ts-expect-error 未知事件名同理
			pi.on('not_an_event', () => {});
			// 载荷 = 上游 `ToolCallEvent` 的形状（按工具名分派的联合，不是 any）
			pi.on('tool_call', (event) => {
				const toolCallId: string = event.toolCallId;
				// 自造工具走 `CustomToolCallEvent` 分支：`input` 是 `Record<string, unknown>`
				if (event.toolName === 'my-tool') {
					const args: Record<string, unknown> = event.input;
					void args;
				}
				// @ts-expect-error 载荷不是 any：不存在的字段必须报错
				void event.notAField;
				void toolCallId;
				return { block: true, reason: '不让跑' };
			});
			// `session_start` 的 `reason` 只有宿主知道（loader 也不知道）
			pi.on('session_start', (event) => { void (event.reason satisfies 'startup' | 'reload' | 'new' | 'resume' | 'fork'); });
		};
		expect(typeof e).toBe('function');
	});
});
