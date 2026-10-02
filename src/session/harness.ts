// src/session/harness.ts —— 浏览器侧的会话/Harness 装配（1.0.0 批 2 B-2）。
//
// 为什么存在：pi 1.0.0 把 `pi-agent-core` 的 `harness/` 整块删掉，编排层落到
// `@earendil-works/pi-durable`（`dist/harness/`）。`Harness.open(storage, options, context)` 自己已经做了
// 绝大部分事（会话表、调度器、内建 generation/tool/compaction 任务、恢复），本仓**不重做**其中任何一件
// （compaction 的接线归 B-4）。这里只做两件浏览器侧特有的事：
//
//   ① `openBrowserHarness`：把「存储 + 模型 + 工具注册表 + 执行环境」按上游要求的形状接起来，并**逐个从
//      参数收**——本仓不该知道任何具体 provider（模型）、也不该替宿主决定工具面与执行环境。
//   ② `asDurableTools`：把本仓七工具（`AgentTool`）接成 durable 的 `ToolRegistration`，并**标 `replay`**。
//
// 「调用方要提供什么」（本仓一律不硬编，理由逐条）：
//   · `models`（`HarnessOptions.models`，`harness/types.d.ts`）：pi-ai 的模型访问。选哪个 provider、
//     怎么拿凭据、怎么 refresh catalog，全是宿主的事；本仓只往下一路传，测试里传的也是替身。
//   · `registry`（`HarnessOptions.registry`）：工具/扩展注册表，宿主用上游 `createRegistry()` 造（内建任务
//     在里面），再 `install` 自己的扩展——扩展的**选择**是每个 conversation 的 `pi.agent.extensions`，
//     装配层无权替宿主定。
//   · `storage`：B-1 `openBrowserSessionStorage` 的产物（本仓只提供开法，不在装配里偷偷开）。
//   · `env`：见下「env 是逐次构造的」。
//   · `settings?` / `now?` / `onReport?`：上游运行期策略（扩展默认选择、stream/retry/compaction 参数、
//     时钟、扩展失败的落点）。原样转发，缺省即上游缺省。`conversationCreated?` **不收**：它是创建提交里
//     写 `pi.*` 文档的钩子（表读会抛 `ReadAfterWrite`），是宿主的建会内部件，不属于「装配」。
//
// 工作目录不在本装配的参数里：`Harness.open` 没有 cwd 的位置。工作目录是**每个 conversation 的**
// `pi.agent.cwd`（`AgentState.cwd`），上游在每次要用环境时读它（`harness.js` 的 `buildEnv`），
// 连同 `conversationId` 一起交给 `HarnessOptions.env` 的 `EnvTarget`——所以宿主在自己的 `env` 构造器里
// 拿到 `target.cwd` 决定挂载/前缀即可，本仓再收一个 cwd 就是没有消费者的死配置（AGENTS §2）。
//
// **没有中止通道**（上游契约，不是本仓的缺口）：`ToolExecutionApi`（`harness/types.d.ts`）**没有 `signal`**，
// 所以经 `Harness` 跑的工具执行**无法中途取消**——只有 `TaskRuntime.signal` 在任务层（abort mark 生效时
// 任务结束，但已经进到 `execute()` 里的那次调用收不到信号）。本仓的 `asDurableTool` 因此给 `execute`
// 传的 signal 是 `undefined`（见 tools/durable-tool.ts 文件头）。接入方必须知道这条限制：chat 主线上的
// 「中止」对工具这一层不生效，只能等它自己返回。
import { Harness } from '@earendil-works/pi-durable';
import type { HarnessOptions, HarnessSettings, RegistryReader, Storage, ToolRegistration } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai';
import type { TSchema } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Context } from '../env/context';
import { asDurableTool } from '../tools/durable-tool';

export interface OpenBrowserHarnessOptions {
	/** pi-ai 模型访问（`HarnessOptions.models`）：宿主提供，本仓不认 provider。 */
	readonly models: Models;
	/** 工具/扩展注册表（`HarnessOptions.registry`）：`createRegistry()` 的产物，可运行中继续增删。 */
	readonly registry: RegistryReader;
	/** 会话存储：B-1 `openBrowserSessionStorage` 的产物（`Storage` 契约，`close` 在其中）。 */
	readonly storage: Storage;
	/** chord `Context`：`Harness.open` 的第三个参数，与 fs 各方法同一个（`BACKGROUND_CONTEXT` 即可）。 */
	readonly context: Context;
	/**
	 * 逐次调用构造一个 conversation 的执行环境（`HarnessOptions.env`）。上游在**每次**工具调用前重建它
	 * （`harness/tool.js`：「Built for this call, so a rerun after recovery gets the conversation's
	 * environment at that time」），可以异步。缺省 = 工具拿不到 `api.env`。
	 */
	readonly env?: HarnessOptions['env'];
	/** 运行期策略：扩展默认选择、stream/retry/compaction/工具轮并行度、排队模式。缺省即上游缺省。 */
	readonly settings?: HarnessSettings;
	/** Harness 时钟（`HarnessOptions.now`）：缺省用 `Date.now`。 */
	readonly now?: () => number;
	/** 不让调用方失败的扩展错误的落点（`HarnessOptions.onReport`）：**不许抛**。 */
	readonly onReport?: (error: unknown) => void;
}

/**
 * 在本仓的浏览器存储上打开一个 pi-durable `Harness`。
 *
 * 只做转发：会话、调度、任务与恢复都在上游 `Harness.open` 里；本仓提供的是「浏览器那端的存储 + 工具面
 * + 参数形状」。返回的 `Harness` 已经是可跑的（`resume()` 由上游在需要进度时自调，也可显式调）。
 */
export function openBrowserHarness(options: OpenBrowserHarnessOptions): Promise<Harness> {
	const { models, registry, storage, context, env, settings, now, onReport } = options;
	return Harness.open(storage, {
		models,
		registry,
		...(env === undefined ? {} : { env }),
		...(settings === undefined ? {} : { settings }),
		...(now === undefined ? {} : { now }),
		...(onReport === undefined ? {} : { onReport }),
	}, context);
}

/**
 * 允许「中断后重跑」的工具名（其余一律不标 = 缺省 `unsafe`）。
 *
 * 依据 `dist/harness/tool.js` 的恢复分支（原文）：
 *   `/** Recovery after intent: rerun only when the stored and the current policy both say `safe`. *\/`
 *   → `if (replay === 'safe' && tool?.replay === 'safe')` 才重跑，否则如实报
 *     `Tool X was interrupted and may have partially run`。
 * **词表与字面直觉相反**：`replay: 'safe'` 才是「可以安全重跑」，`'unsafe'`（缺省）是「不重跑」。
 *
 * 分档理由（与词表相反这件事，是本仓的策略选择，不是翻译）：
 *   · **只读**（`read` / `grep` / `ls` / `find`）→ `safe`：重跑只是再读一次，外部不可观测，中断后自动
 *     续上比让人看见一条「可能已部分执行」的假警报有用。
 *   · **有副作用**（`write` / `edit` / `bash`）→ **不标**（缺省 `unsafe`）：中断时可能已经部分落盘（文件写了
 *     一半、命令跑了半截），静默重跑比不重跑更危险——重复写、重复执行都可能造成第二次损害。宁可如实报
 *     「可能已部分执行」，让人知道要去看一眼。
 *   · 名单之外的工具**默认 unsafe**：这张表是白名单而不是黑名单，将来加工具时缺省是安全的那一档。
 */
const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'ls', 'find']);

/**
 * 把一批本仓工具（`AgentTool`，七工厂的产物）接成 pi-durable 可注册的 `ToolRegistration`，并按上表标注
 * `replay`。装法与 B-3 的 `asDurableTool` 相同（同一个适配、逐个调用），差别只有这层**策略**标注。
 *
 * @param tools 本仓工具；名字决定 replay 档位，构造期的依赖注入（fs / operations）已定型
 * @returns 可直接 `registry.install({ name, tools })` 的工具数组
 */
export function asDurableTools(tools: readonly AgentTool<any, any>[]): ToolRegistration[] {
	return tools.map((tool) => {
		const registration = asDurableTool(tool);
		return REPLAY_SAFE_TOOLS.has(tool.name) ? { ...registration, replay: 'safe' as const } : registration;
	});
}
