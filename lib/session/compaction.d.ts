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
export declare const DEFAULT_BROWSER_COMPACTION_POLICY: CompactionPolicy;
