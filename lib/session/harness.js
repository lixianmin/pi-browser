// src/session/harness.ts —— 浏览器侧的会话/Harness 装配（1.0.0 批 2 B-2）。
//
// 为什么存在：pi 1.0.0 把 `pi-agent-core` 的 `harness/` 整块删掉，编排层落到
// `@earendil-works/pi-durable`（`dist/harness/`）。`Harness.open(storage, options, context)` 自己已经做了
// 绝大部分事（会话表、调度器、内建 generation/tool/compaction 任务、恢复），本仓**不重做**其中任何一件
// （compaction 的执行体与缺省策略都在 durable 那边，内建 `CompactionTask` + `resolveSettings`，装配层不
// 参与——背景与字段清单见 `session/compaction.ts`）。
// 这里只做两件浏览器侧特有的事：
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
// 中止通道走 `Context`：`ToolExecutionApi`（`harness/types.d.ts`）本身没有 `signal` 字段，但
// `ToolRegistration.execute(args, api, context)` 的第三个参数是 chord `Context`，其 `abortSignal` 就是本次调用的
// 取消信号（调度器用 `withAbortSignal` 构造）。`asDurableTool` 已把它转给 `AgentTool.execute` 的 signal
// （见 tools/durable-tool.ts），所以经 `Harness` 跑的工具（含 bash 超时/中止）可以被打断。
import { Harness } from '@earendil-works/pi-durable';
import { asDurableTool } from '../tools/durable-tool.js';
/**
 * 在本仓的浏览器存储上打开一个 pi-durable `Harness`。
 *
 * 只做转发：会话、调度、任务与恢复都在上游 `Harness.open` 里；本仓提供的是「浏览器那端的存储 + 工具面
 * + 参数形状」。返回的 `Harness` 已经是可跑的（`resume()` 由上游在需要进度时自调，也可显式调）。
 */
export function openBrowserHarness(options) {
    const { models, registry, storage, context, env, settings, now, onReport } = options;
    return Harness.open(storage, {
        models,
        registry,
        ...(env === undefined ? {} : { env }),
        // 原样转发：durable 的 `resolveSettings` 已经在 `settings` 为空时补齐全部缺省
        // （`compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction }`），装配层再 merge 一份
        // 与它逐字相同的值，产出的对象与不 merge 完全一致。`resolveSettings` 不改调用方的对象，转发安全。
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
const REPLAY_SAFE_TOOLS = new Set(['read', 'grep', 'ls', 'find']);
/**
 * 把一批本仓工具（`AgentTool`，七工厂的产物）接成 pi-durable 可注册的 `ToolRegistration`，并按上表标注
 * `replay`。装法与 B-3 的 `asDurableTool` 相同（同一个适配、逐个调用），差别只有这层**策略**标注。
 *
 * @param tools 本仓工具；名字决定 replay 档位，构造期的依赖注入（fs / operations）已定型
 * @returns 可直接 `registry.install({ name, tools })` 的工具数组
 */
export function asDurableTools(tools) {
    return tools.map((tool) => {
        const registration = asDurableTool(tool);
        return REPLAY_SAFE_TOOLS.has(tool.name) ? { ...registration, replay: 'safe' } : registration;
    });
}
