/**
 * 上游 `CompactionSummaryMessage`（两版逐字相同：`messages.js` 旁的 interface，四字段）。
 * 本地声明的原因：0.99.1 的 agent-core 根入口**不导出**这个类型（只在 `harness/messages` 内部），
 * 1.0.0 把它留在 CLI 仓的 `core/messages.d.ts` —— 两边都没有可 import 的公开名。
 */
export interface CompactionSummaryMessage {
    role: 'compactionSummary';
    summary: string;
    tokensBefore: number;
    timestamp: number;
}
/** 上游 `CompactionSettings`（三字段，逐字）。 */
export interface CompactionSettings {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
}
/** 上游 `DEFAULT_COMPACTION_SETTINGS`（逐字；两版数值一致）。 */
export declare const DEFAULT_COMPACTION_SETTINGS: CompactionSettings;
/**
 * 由一条 compaction 条目造出喂回模型的 `compactionSummary` 消息（上游 `messages.js:48-55` 逐字）。
 *
 * 1.0.0 与 0.99.1 有一处签名差异：0.99.1 是 `(summary, tokensBefore, timestamp: string | number)` 且
 * number 直接透传，1.0.0 收 `timestamp: string` 并恒走 `new Date(timestamp).getTime()`。这里按 1.0.0
 * 对齐（**公开面随版本走**）；运行期传 number 仍得到相同结果（`new Date(1234).getTime() === 1234`），
 * 所以对既有调用方是兼容的，只是类型面从宽收窄。
 */
export declare function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string): CompactionSummaryMessage;
