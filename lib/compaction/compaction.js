/** 上游 `DEFAULT_COMPACTION_SETTINGS`（逐字；两版数值一致）。 */
export const DEFAULT_COMPACTION_SETTINGS = {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
};
/**
 * 由一条 compaction 条目造出喂回模型的 `compactionSummary` 消息（上游 `messages.js:48-55` 逐字）。
 *
 * 1.0.0 与 0.99.1 有一处签名差异：0.99.1 是 `(summary, tokensBefore, timestamp: string | number)` 且
 * number 直接透传，1.0.0 收 `timestamp: string` 并恒走 `new Date(timestamp).getTime()`。这里按 1.0.0
 * 对齐（**公开面随版本走**）；运行期传 number 仍得到相同结果（`new Date(1234).getTime() === 1234`），
 * 所以对既有调用方是兼容的，只是类型面从宽收窄。
 */
export function createCompactionSummaryMessage(summary, tokensBefore, timestamp) {
    return {
        role: 'compactionSummary',
        summary: summary,
        tokensBefore,
        timestamp: new Date(timestamp).getTime(),
    };
}
