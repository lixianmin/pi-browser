import { logo } from '@needle/needle';
import { summarize } from '../logging.js';
/**
 * 把一份本仓工具（`AgentTool`，七工厂的产物）适配成 pi-durable 编排层可注册的 `ToolRegistration`。
 *
 * 依赖注入（fs / operations）在**构造期**就已定型（见文件头「为什么 fs 在构造期捕获」）：
 * 适配只做 execute 的翻译与结果的投影。
 *
 * @param tool 本仓工具；`execute` 的 `toolCallId` 取 `api.callId`（durable 侧逐次调用唯一的调用标识）
 * @returns 可装进 pi-durable `Registry` 的工具注册件
 */
export function asDurableTool(tool) {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (args, api, context) => {
            // 打点（spec 2026-10-23 §4）：七工具在 durable 编排下的**唯一**执行收口——一处覆盖全部工具调用。
            // 起一条（名 + 参数摘要）、收一条（耗时 + 成败）：工具卡住时至少能看到「它开始了」。
            const startedAt = Date.now();
            logo.info('tool call', { tool: tool.name, args: summarize(args) });
            try {
                // 抛错不吞：工具抛错照原样冒泡，由 durable 侧记成 isError 的结果（与 tool-definition-wrapper 同一处置）
                // 取消信号只在 chord Context 上（ToolExecutionApi 没有 abortSignal）：漏传它 = 所有工具都无法
                // 被 abort/timeout 打断，bash 会一直跑到底、read 的取消立即 reject 也成了死代码。
                const result = await tool.execute(api.callId, args, context.abortSignal, (partial) => {
                    for (const block of partial.content) {
                        if (block.type === 'text')
                            api.output(block.text);
                    }
                });
                logo.info('tool done', { tool: tool.name, durationMs: Date.now() - startedAt, isError: result.isError === true });
                // 缺省的键整个不出现（见文件头 ③）
                return {
                    output: result.content,
                    ...(result.details === undefined ? {} : { details: result.details }),
                    ...(result.isError === undefined ? {} : { isError: result.isError }),
                    ...(result.usage === undefined ? {} : { usage: result.usage }),
                };
            }
            catch (error) {
                logo.error('tool failed', error, { tool: tool.name, durationMs: Date.now() - startedAt });
                throw error;
            }
        },
    };
}
