// src/logging.ts —— 本仓日志面（needle `@needle/logo`）的全仓唯一入口。
//
// 为什么用 needle 而不是 console：库自己写日志、宿主决定日志去哪（文件 / 飞书 / 调试控制台），
// 这需要「级别 + 结构化字段 + 可插 sink」三样东西，`console.*` 一样都没有。needle 是同机已有的库
// （`/Users/xmli/me/code/needle`），零运行时依赖、浏览器可用，`video.downloader` 已在用同一套。
// 设计依据见 `docs/superpowers/specs/2026-10-23-pi-browser-logging-design.md`。
//
// 为什么自己造实例、而不是用 needle 的全局 `logo`：needle 的 `child()` 会**快照**父级的 sink
// （实现如此），模块加载时建好的 child 拿不到宿主后挂的 sink。自己造实例并从公开面导出，
// 宿主 `logger.addSink(...)` 才有的放矢。
//
// 默认带 stdout sink：浏览器里落 `console`、Node 里落 stdout（needle 的 `hasStdout()` 能力探测），
// 开箱就有可观测性；宿主要更安静就 `logger.setLevel('warn')`。
import { newLogger, safeStringify, stdoutSink, type Logger } from '@needle/logo';

export type { Logger };

/** 本仓日志器：宿主从公开面拿到它，`addSink` 挂自己的 sink 即接管本仓全部日志。 */
export const logger: Logger = newLogger({ name: 'pi-browser', level: 'info', sinks: [stdoutSink] });

/** 参数摘要的默认长度上限：工具入参可能含整个文件内容（write 的 content），原样进日志既刷屏又可能泄密。 */
const DEFAULT_MAX_CHARS = 500;

/**
 * 把任意入参压成一行可进日志的字符串：字符串原样（不加引号——命令、路径这类直接可读），
 * 其余 JSON 化（`safeStringify` 保证循环引用/BigInt 不炸），超长截断。截断标记用 `…`（末尾可见）。
 */
export function summarize(value: unknown, maxChars: number = DEFAULT_MAX_CHARS): string {
	const text = typeof value === 'string' ? value : safeStringify(value);
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
