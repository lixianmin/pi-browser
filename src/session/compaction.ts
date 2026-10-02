// src/session/compaction.ts —— compaction 接缝的浏览器侧默认策略（1.0.0 批 2 B-4）。
//
// ## 1.0.0 之后 compaction 的分工（这是本文件存在的全部理由）
//
// 压缩本身**整个**在 durable 那边，本仓一行实现都没有、也不该有：
//   · `dist/harness/compaction.js` 的内建 `CompactionTask`（`defineTask`，name `pi.compaction`）是压缩的
//     执行者。`select` 相位按 `settings.compaction.keepRecentTokens` 用 `selectCut` 选切点（没有可切的
//     就直接 `complete`），`summarize` 相位调 `runtime.models.completeSimple` 拿摘要，`placeSummary`
//     最后写一条 `CompactionEntry`（kind `pi.compaction`，`head` 指向第一条保留的 entry）。
//   · `createCompaction(tx, conversationId, input, owner?)` 是**创建**这个任务的入口，不是另一套压缩实现：
//     给 `owner`（TaskId）就是「这一代生成要等它」的阻塞压缩（摘要直接 append）；不给就是会话自有的，
//     且除非 `input.reason === 'manual'` 一律是后台任务，摘要经 `admitSubmission` 走写提交落盘。
//   · 触发由 generation 在 `prepare` 相位判定（`thresholdCompaction`）：`contextWindow - reserveTokens`
//     是阻塞阈值，再低 `backgroundTokens` 是后台阈值，`enabled: false` 一律不压；上下文溢出
//     （`stopReason: 'error'` 且是 context overflow）另走 `reason: 'overflow'`。
//
// 摘要消息也是 durable 造的，不经本仓：`placeSummary` 写的是一条**带摘要的 `[UserMessage]`**
// （正文包在 `<summary>` 里），不是 `role: 'compactionSummary'`。后者是 CLI 侧 `core/messages` 的形状，
// 由 `@earendil-works/pi-coding-agent` 的 `buildSessionContext` 还原——见下面「自持副本」一节。
//
// ## 本仓那份自持副本（`src/compaction/compaction.ts`）的来历与现状
//
// 它是 P4 为了对齐上游而收进本包的**实现体副本**：`createCompactionSummaryMessage` /
// `DEFAULT_COMPACTION_SETTINGS` / `CompactionSettings` 在 pi-agent-core@0.99.1 里是 re-export，
// 1.0.0 把它们搬到了 CLI 侧、不再从 agent-core 导出，于是本包自持一份、公开面（名字与形状）不变。
// 保真靠 `test/compaction-selfhosted.test.ts` 逐字 import 上游 `dist/core/messages.js` 比对。
//
// 走 durable 编排路线后它承担的是**另一件事**：CLI 侧会话文件（`pi-coding-agent` 的 JSONL transcript）
// 那一半的压缩面——`role: 'compactionSummary'` 消息与三字段 `CompactionSettings` 是那份文件格式的读法，
// `test/compaction-integration.test.ts` 锁的正是「本包造的消息能被上游 `buildSessionContext` 还原」。
// durable 的 `CompactionEntry` 与本仓这两者**不互换**（entry kind 不同、消息角色不同），所以副本不是
// 「被 durable 顶掉的重复实现」，而是**另一条数据通路**的适配件。是否收窄它（连同它的两条测试与
// 公开面导出）由控制方裁决，本轮不动。
//
// ## 为什么默认值取 durable 的 `DEFAULT_COMPACTION_POLICY` 而不是自持副本那份
//
// **两者不是同一个契约**，`src/index.ts` 两个常量都导出，名字刻意不同：
//   · `DEFAULT_COMPACTION_SETTINGS`（自持，CLI 侧）：三字段 `enabled` / `reserveTokens` /
//     `keepRecentTokens`，值 16384 / 20000。喂给上游 `shouldCompact(tokens, contextWindow, settings)`。
//   · `DEFAULT_COMPACTION_POLICY`（durable）：四字段——前三项同名**同值**（`enabled: true`、
//     `reserveTokens: 16384`、`keepRecentTokens: 20000`，1.0.0 仍未变），**多一个**
//     `backgroundTokens: 32768`（低于阻塞阈值这么多就开始后台压缩；`0` 关闭后台压缩）。
//     喂给 durable 的 `HarnessSettings.compaction`（`HarnessSettings` 那一位是 `Partial<CompactionPolicy>`，
//     缺省字段由 `resolveSettings` 拿 `DEFAULT_COMPACTION_POLICY` 补齐）。
// 本仓公开面给的是 durable 那一份（不是自持副本那三字段）：`HarnessSettings.compaction` 的缺省由 durable 的
// `resolveSettings` 拿 `DEFAULT_COMPACTION_POLICY` 补齐，接入方要覆盖就经 `OpenBrowserHarnessOptions.settings`
// 给 `Partial<CompactionPolicy>`，缺的字段照样由上游补。`backgroundTokens` 那个多出来的字段就是后台压缩的开关。
import { DEFAULT_COMPACTION_POLICY } from '@earendil-works/pi-durable';
import type { CompactionPolicy } from '@earendil-works/pi-durable';

/**
 * durable 侧 compaction 默认策略（`CompactionPolicy` 四字段）在公开面上的本仓名字。
 *
 * **逐字段等于** durable 的 `DEFAULT_COMPACTION_POLICY`（`dist/harness/agent.js:9-14`）——这是一份**镜像**，
 * 存在的理由是让「接缝上用的是哪几个字段、值是多少」在本仓的公开面与文档里是自陈的，接入方不必翻上游源码。
 * `test/session-compaction.test.ts` 对着上游真常量断言它，上游改数值这里就红。
 *
 * **装配层不 merge 它**：`openBrowserHarness` 把 `settings` 原样转发给 `Harness.open`，缺省由 durable 自己的
 * `resolveSettings` 填（`compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction }`），与这份镜像
 * 逐字相同，所以在这里再 merge 一次是产出同值的死接线。调用方要改就经
 * `OpenBrowserHarnessOptions.settings.compaction` 覆盖任意字段（`Partial<CompactionPolicy>`）。
 */
export const DEFAULT_BROWSER_COMPACTION_POLICY: CompactionPolicy = { ...DEFAULT_COMPACTION_POLICY };
