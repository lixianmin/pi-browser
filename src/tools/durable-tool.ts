// src/tools/durable-tool.ts —— `AgentTool`（本仓七工厂的产物）→ pi-durable `ToolRegistration` 的适配（批 2 B-3）。
//
// 为什么需要：pi 1.0.0 把 pi-agent-core 的 `harness/` 整块删掉，编排层落到 `@earendil-works/pi-durable`，
// 它的工具注册面（`dist/harness/types.d.ts:144` 的 `ToolRegistration`）与 core 的 `AgentTool`
// （`pi-agent-core/dist/types.d.ts:407`）**同源不同构**：两边都建立在 pi-ai 的 `Tool<TParameters>` 上，
// 共有的实义字段只有 `name` / `description` / `parameters`（`constrainedSampling` 两边都没人用）。
// execute 与结果面各有一套：
//   core     execute(toolCallId, params, signal?, onUpdate?) → AgentToolResult{content, details, structuredContent?, usage?, isError?, terminate?}
//   durable  execute(args, api: ToolExecutionApi, context)      → ToolExecutionResult{content?, isError?, details?, diagnostics?, usage?, control?}
// 适配 = execute 的翻译 + 结果的投影。
//
// 逐条映射，以及**有意不搬**的字段（都写在这里，免得后来人以为漏了）：
//   ① `name` / `description` / `parameters` 直传（两边共有的 `Tool` 字段）。
//   ② `api.output(chunk)` ← `onUpdate` 的**文本块**：`api.output` 是 pi-durable 唯一的流式通道
//      （`harness/types.d.ts:124`；它说结果省略 `content` 时留存的 output 会成为结果内容）。
//      图片块**不进流**：`output` 收 `string | Uint8Array`，图片的 base64 + mimeType 没有无损表达；
//      图片走最终结果的 `content`（本仓 read 的图片块本来就在那里），流的职责是「正在跑」的文本。
//   ③ `content` / `details` / `isError` / `usage` 直传；缺省的键**整个不出现**（不是显式 undefined）——
//      durable 侧省略 `content` / `details` 各有兜底语义（留存的 output / 最后一次 `api.details()`），
//      写成 `undefined` 会把那些兜底绕过去。
//   ④ `structuredContent`：**不搬**。durable 的 `ToolExecutionResult` 没有对应字段，而本仓七工厂
//      都不产它（`grep -rn structuredContent src/tools/` 零命中；`test/durable-tool.test.ts` 最后一条
//      用例把这个前提守住）——今天丢的是空气，不是东西。哪天某个工具开始产它，那时再决定塞进
//      `details` 还是让宿主从 `AgentTool` 侧旁路取，不是在这里静默丢。
//   ⑤ **不搬** core 侧其余字段：`label`（durable 的 `Tool` 里没有这个位置，UI 标签得宿主自己从注册表给）、
//      `prepareArguments`（两边签名相同，但七工厂都不声明，搬过来是死代码）、`outputSchema`（同 ④）、
//      `replay` / `executionMode`（**词表不同**：core 是 `'never' | 'safe'`，durable 是 `'safe' | 'unsafe'`
//      且缺省 `unsafe`，直传会把语义说反）、`terminate`（durable 侧叫 `control`）。
//      前几个留到真有值时再补；`replay` 是**策略**不是翻译（write/edit/bash 是副作用，
//      read/grep/ls/find 是纯读），归 B-2/B-4 的恢复语义决定，不在本件里猜。
//
// 为什么 fs 在**构造期**捕获、不从 `api.env` 取：`ToolExecutionApi.env` 是 `ExecutionEnv | undefined`
// （`harness/types.d.ts:122`，由 `HarnessOptions.env` 为本次调用构造），逐次调用换 env 确实更灵活。
// 但本仓的工具缝不是 env：`ReadOperations` / `GrepOperations` 等是**逐工具**的窄接口（D5），grep 还要一个
// 具体的 `BrowserFileSystem`（上游把遍历外包给 rg，浏览器没有）。而 `ExecutionEnv`
// （`pi-durable/dist/env/index.d.ts:109` = `FileSystem & Shell`）里**取不出** `BrowserFileSystem`——
// `createBrowserExecutionEnv` 把挂载表摊平成 fs 方法（src/env/execution-env.ts），没有回指 fs 实例的字段。
// 所以宿主在装配注册表时（`createBrowserExecutionEnv` / `createBrowserFileSystem` 手里就有）造好工具，
// 适配层只翻形状，不碰依赖注入。
//
// 为什么是**一个**通用函数而不是「通用 + 七个薄封装」：七工具在适配这件事上**没有差别**——差别全在
// 构造参数里（grep 的 `fs`、bash 的 `operations`/`spill`/`commandPrefix`），那是工厂的活，适配层看不见。
// 七个薄封装只多出七个零行为的公开导出（每个都要进 README 公开面表 + `public-surface` 断言），
// 宿主写 `asDurableTool(createReadTool(cwd, { operations }))` 和写 `createDurableReadTool(cwd, { operations })`
// 成本一样、信息量一样。等真有逐工具差异（最可能是 ⑤ 的 `replay` 策略）时，差异落在这一层里的一张
// 小表或一个可选策略参数上，仍然不需要七个函数。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import type { TSchema } from '@earendil-works/pi-ai';

/**
 * 把一份本仓工具（`AgentTool`，七工厂的产物）适配成 pi-durable 编排层可注册的 `ToolRegistration`。
 *
 * 依赖注入（fs / operations）在**构造期**就已定型（见文件头「为什么 fs 在构造期捕获」）：
 * 适配只做 execute 的翻译与结果的投影。
 *
 * @param tool 本仓工具；`execute` 的 `toolCallId` 取 `api.callId`（durable 侧逐次调用唯一的调用标识）
 * @returns 可装进 pi-durable `Registry` 的工具注册件
 */
export function asDurableTool<TParameters extends TSchema>(
	tool: AgentTool<TParameters, any>,
): ToolRegistration<TParameters, any> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execute: async (args, api, _context) => {
			// 抛错不吞：工具抛错照原样冒泡，由 durable 侧记成 isError 的结果（与 tool-definition-wrapper 同一处置）
			const result = await tool.execute(api.callId, args, undefined, (partial) => {
				for (const block of partial.content) {
					if (block.type === 'text') api.output(block.text);
				}
			});
			// 缺省的键整个不出现（见文件头 ③）
			return {
				content: result.content,
				...(result.details === undefined ? {} : { details: result.details }),
				...(result.isError === undefined ? {} : { isError: result.isError }),
				...(result.usage === undefined ? {} : { usage: result.usage }),
			};
		},
	};
}
