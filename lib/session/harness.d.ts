import { Harness } from '@earendil-works/pi-durable';
import type { HarnessOptions, HarnessSettings, RegistryReader, Storage, ToolRegistration } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Context } from '../env/context.js';
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
    /**
     * 运行期策略：扩展默认选择、stream/retry/compaction/工具轮并行度、排队模式。
     * 缺省即上游缺省：原样转发，缺省值由 durable 的 `resolveSettings` 补齐（`compaction` 那一组也包括在内），
     * 替上游定默认不是装配的职责。
     */
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
export declare function openBrowserHarness(options: OpenBrowserHarnessOptions): Promise<Harness>;
/**
 * 把一批本仓工具（`AgentTool`，七工厂的产物）接成 pi-durable 可注册的 `ToolRegistration`，并按上表标注
 * `replay`。装法与 B-3 的 `asDurableTool` 相同（同一个适配、逐个调用），差别只有这层**策略**标注。
 *
 * @param tools 本仓工具；名字决定 replay 档位，构造期的依赖注入（fs / operations）已定型
 * @returns 可直接 `registry.install({ name, tools })` 的工具数组
 */
export declare function asDurableTools(tools: readonly AgentTool<any, any>[]): ToolRegistration[];
