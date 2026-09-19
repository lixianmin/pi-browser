// src/extensions/runner.ts —— S6 spec §3.1/§3.5：浏览器侧**宿主**（pi `ExtensionRunner` 同名）。
//
// 它是唯一持有 `context` 与注册表的地方：pi 的扩展面每个成员都不带 `context`，而 pi-agent-core 每个方法
// 都要 —— 这个「context 反演」就是本文件存在的理由（同 spec §3.1 的分层图）。
//
// 三件事：
//   ① 加载扩展（工厂式：`(pi: ExtensionAPI) => void | Promise<void>`），注册期把运行期成员锁住；
//   ② 工具注册表：重名**后写覆盖先写**（对齐 pi 宿主的 Map 语义）+ 一行 `console.warn`（唯一刻意的行为差异，
//      见 spec §3.5——本仓有「静默失效比报错更糟」的教训，但不新增自造接口名来承载告警）；
//   ③ `on(event, handler)` 路由：pi 事件名 → pi-agent-core 的 hooks / events（表见下）。
import type { AgentHarness, AgentLane, Context, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { SUPPORTED_EVENTS, UNSUPPORTED_EVENTS } from './contract';
import { createExtensionAPI, type Extension, type ExtensionAPI, type ExtensionBindings, type HostLifecycleListener, type SourceInfo, type ToolInfo } from './api';
import { createExtensionContext } from './context';
import { toHarnessTool } from './harness-tool';
import type { ToolDefinition } from './tool';

/** `on(event, handler)` 的路由表：pi 事件名 → pi-agent-core 落点（S6 spec §3.4 逐项裁决）。 */
type EventRoute =
	| { kind: 'hook'; name: string }
	| { kind: 'event'; name: string; property?: string }
	| { kind: 'host'; name: 'session_start' | 'session_shutdown' };

const EVENT_ROUTES: Readonly<Record<string, EventRoute>> = {
	context: { kind: 'hook', name: 'transform_context' },
	before_agent_start: { kind: 'hook', name: 'before_run' },
	agent_start: { kind: 'event', name: 'run_start' },
	agent_end: { kind: 'event', name: 'run_end' },
	turn_start: { kind: 'event', name: 'turn_start' },
	turn_end: { kind: 'event', name: 'turn_end' },
	message_start: { kind: 'event', name: 'message_start' },
	message_update: { kind: 'event', name: 'message_update' },
	message_end: { kind: 'event', name: 'message_end' },
	tool_execution_start: { kind: 'event', name: 'tool_start' },
	tool_execution_update: { kind: 'event', name: 'tool_update' },
	tool_execution_end: { kind: 'event', name: 'tool_end' },
	tool_call: { kind: 'hook', name: 'before_tool' },
	tool_result: { kind: 'hook', name: 'after_tool' },
	session_before_compact: { kind: 'hook', name: 'before_compaction' },
	session_compact: { kind: 'event', name: 'compaction_end' },
	session_before_tree: { kind: 'hook', name: 'before_navigation' },
	session_tree: { kind: 'event', name: 'navigation_end' },
	session_start: { kind: 'host', name: 'session_start' },
	session_shutdown: { kind: 'host', name: 'session_shutdown' },
	model_select: { kind: 'event', name: 'config_update', property: 'model' },
	thinking_level_select: { kind: 'event', name: 'config_update', property: 'thinkingLevel' },
	before_provider_request: { kind: 'hook', name: 'before_request' },
	before_provider_headers: { kind: 'hook', name: 'before_request' },
	after_provider_response: { kind: 'hook', name: 'after_response' },
};

interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionRunnerOptions extends ExtensionBindings {
	/** 缺省 `BACKGROUND_CONTEXT` 由调用方注入（本层不 import 上游默认值，便于单测注入假 context） */
	context: Context;
	/** 初始思考档位（同步缓存起点） */
	thinkingLevel: ThinkingLevel;
	/** 初始模型（`ctx.model`） */
	model?: Model<any>;
}

/**
 * 宿主：加载扩展 → 收工具 → 同步进 harness/lane；并提供 `hooks`/`events` 的只读出口。
 * 加载完成后进入 `active` 相位；此前扩展工厂里调用运行期成员会**响亮抛错**（对齐 pi 的 `assertActive()`）。
 */
export class ExtensionRunner {
	private readonly registered = new Map<string, RegisteredTool>();
	private phase: 'loading' | 'active' = 'loading';
	private readonly apiPerSource = new Map<string, ExtensionAPI>();
	private readonly hostListeners = new Set<HostLifecycleListener>();

	constructor(private readonly bindings: ExtensionRunnerOptions) {}

	get hooks() {
		return this.bindings.harness.hooks;
	}

	get events() {
		return this.bindings.harness.events;
	}

	/** 已注册工具（含来源标签），保持注册顺序（Map 插入序）。 */
	getAllRegisteredTools(): RegisteredTool[] {
		return [...this.registered.values()];
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.registered.get(name)?.definition;
	}

	/** 给某个扩展用的 `ExtensionAPI` 实例（来源标签不同 ⇒ 报错与工具来源能定位到扩展）。 */
	apiFor(source: string): ExtensionAPI {
		const existing = this.apiPerSource.get(source);
		if (existing) return existing;
		const api = createExtensionAPI(this.bindings, {
			source,
			assertActive: () => {
				if (this.phase !== 'active') {
					throw new Error(`扩展 "${source}"：注册期不能调用运行期成员（扩展工厂只能 registerTool / on / 声明）`);
				}
			},
			addTool: (definition, from) => this.addTool(definition, from),
			cache: {
				sessionName: this.bindings.sessionName,
				thinkingLevel: this.bindings.thinkingLevel ?? ('medium' as ThinkingLevel),
				activeTools: [...(this.bindings.activeTools ?? [])],
			},
			onEvent: (event, handler) => this.route(source, event, handler),
			allTools: () => this.getAllRegisteredTools().map((t) => ({
				name: t.definition.name,
				description: t.definition.description,
				parameters: t.definition.parameters,
				promptGuidelines: t.definition.promptGuidelines,
				sourceInfo: t.sourceInfo,
			})),
			setActiveTools: (names) => this.setActiveTools(names),
		}, (signal) => createExtensionContext({
			cwd: this.bindings.cwd,
			model: this.bindings.model,
			lane: this.bindings.lane,
			context: this.bindings.context,
			signal: this.bindings.signal,
		}, signal));
		this.apiPerSource.set(source, api);
		return api;
	}

	/**
	 * 装载扩展并同步工具面。返回装载好的 `ExtensionAPI` 列表（宿主可直接调运行期成员）。
	 * 全部工厂跑完后进入 `active` 相位、发 `session_start`。
	 */
	async load(extensions: readonly Extension[]): Promise<Map<string, ExtensionAPI>> {
		this.phase = 'loading';
		let anonymous = 0;
		for (const ext of extensions) {
			const named = typeof ext === 'function' ? undefined : ext;
			const factory = typeof ext === 'function' ? ext : ext.factory;
			const source = named?.name ?? `<anonymous:${++anonymous}>`;
			await factory(this.apiFor(source));
		}
		this.phase = 'active';
		await this.syncTools();
		await this.emitHost({ type: 'session_start' });
		return this.apiPerSource;
	}

	/** 关掉宿主：先发 `session_shutdown` 再闭锁（之后运行期成员一律抛错）。 */
	async close(): Promise<void> {
		await this.emitHost({ type: 'session_shutdown' });
		this.phase = 'loading';
	}

	/** 把注册表同步进 harness（可用集）与 lane（激活集）——spec §3.7「两层都要管」。 */
	private async syncTools(): Promise<void> {
		const names = [...this.registered.keys()];
		await this.bindings.harness.setTools(
			this.getAllRegisteredTools().map((t) => toHarnessTool(t.definition, (signal) => createExtensionContext({
				cwd: this.bindings.cwd,
				model: this.bindings.model,
				lane: this.bindings.lane,
				context: this.bindings.context,
				signal: this.bindings.signal,
			}, signal))),
			this.bindings.context,
		);
		await this.bindings.lane.setActiveTools(names, this.bindings.context);
	}

	private setActiveTools(names: string[]): void {
		void this.bindings.lane.setActiveTools(names, this.bindings.context)
			.catch((e: unknown) => console.warn(`[extensions] setActiveTools 失败：${(e as Error)?.message ?? String(e)}`));
	}

	private addTool(definition: ToolDefinition, source: string): void {
		const previous = this.registered.get(definition.name);
		if (previous) {
			// 对齐 pi 宿主语义（Map.set：后写覆盖先写），差异只有这一行告警 —— spec §3.5
			console.warn(`[extensions] 工具重名："${definition.name}"：${previous.sourceInfo.source} 被 ${source} 覆盖`);
		}
		this.registered.set(definition.name, {
			definition,
			sourceInfo: {
				// 浏览器里扩展是宿主自己的对象（不经文件系统发现）：path 用合成名，scope 固定 project
				path: `<extension:${source}>`,
				source,
				scope: 'project',
				origin: 'top-level',
			},
		});
	}

	private route(source: string, event: string, handler: (event: unknown) => unknown | Promise<unknown>): void {
		const route = EVENT_ROUTES[event];
		if (!route) {
			throw new Error(`扩展 "${source}"：on("${event}") 不支持（`
				+ `${(UNSUPPORTED_EVENTS as readonly string[]).includes(event) ? '该事件在浏览器侧无对应物' : '未知事件名'}）。`
				+ `支持：${Object.keys(SUPPORTED_EVENTS).join(', ')}`);
		}
		const { harness } = this.bindings;
		if (route.kind === 'host') {
			const name = route.name;
			this.hostListeners.add(async (e) => { if (e.type === name) { await handler(e); } });
			return;
		}
		const property = route.kind === 'event' ? route.property : undefined;
		const wrapped = ((event2: unknown) => {
			if (property !== undefined && (event2 as { property?: string }).property !== property) return undefined;
			return handler(event2);
		}) as never;
		if (route.kind === 'hook') harness.hooks.on(route.name as never, wrapped);
		else harness.events.on(route.name as never, wrapped);
	}

	private async emitHost(event: { type: 'session_start' | 'session_shutdown' }): Promise<void> {
		for (const listener of this.hostListeners) await listener(event);
	}
}
