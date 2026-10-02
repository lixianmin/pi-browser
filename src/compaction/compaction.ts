// src/compaction/compaction.ts —— compaction 的自持实现（P4；spec C10 / F15）。
//
// 为什么自持：`createCompactionSummaryMessage` / `DEFAULT_COMPACTION_SETTINGS` / `CompactionSettings`
// 在 pi-agent-core@0.99.1 里是 re-export（`harness/messages` + `harness/compaction`），而 1.0.0 把整套
// compaction 搬到了 CLI 侧（`core/messages` / `core/compaction`）、不再从 agent-core 导出 —— P6 升版本时
// 这个 re-export 会断。这里把**实现体**收进本包，公开面（名字与形状）保持不变，P6 不用改调用方。
//
// 逐字来源（1.0.0 为准；两版差异见 `createCompactionSummaryMessage` 的注释）：
//   · `createCompactionSummaryMessage` ← `dist/core/messages.js:48-55`
//   · `DEFAULT_COMPACTION_SETTINGS`    ← `dist/core/compaction/compaction.js:53-57`
//   · `CompactionSettings`             ← `dist/core/compaction/compaction.d.ts:28-32`
// 保真不靠人眼：`test/compaction-integration.test.ts` 直接 import 上游 `dist/core/messages.js` 逐字比对
// （与 P2 的「静态契约面 import 上游产物」同一手法）。
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
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
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
export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: 'compactionSummary',
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}
