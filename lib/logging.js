// src/logging.ts —— 本仓打点用 needle（`@needle/logo`）的说明与共用辅助。
//
// **日志一律用 needle 导出的全局 `logo` 实例，不另造 logger。** 需求是「全应用唯一一个 logger」：
// 宿主一处 `logo.addSink(...)` 接管全部日志（含本仓的），`logo.setLevel(...)` 一个旋钮管全局。
// 所以各调用点直接 `import { logo } from '@needle/logo'`，本文件不导出任何 logger 实例。
//
// 为什么不 `logo.child({ name: 'pi-browser' })`：`child()` 是 `sinks: [...sinks]`（`core/logo/logo.ts`）
// ——创建那一刻复制 sink 数组，之后与父级解绑，宿主后挂的 sink 进不了已存在的 child。要嘛直接用
// `logo`（当前选择），要嘛另造实例（放弃唯一实例）。
//
// 有意的代价：记录不带 `name` 字段（`logo` 没设 name；`newLogger({ name })` / `child({ name })` 才带），
// 级别也是全局共享的。这正是「唯一实例」的语义，需要单独档位时由宿主在 sink 侧过滤。
//
// 设计依据见 `docs/superpowers/specs/2026-10-23-pi-browser-logging-design.md`。
import { safeStringify } from '@needle/logo';
/** 参数摘要的默认长度上限：工具入参可能含整个文件内容（write 的 content），原样进日志既刷屏又可能泄密。 */
const DEFAULT_MAX_CHARS = 500;
/**
 * 把任意入参压成一行可进日志的字符串：字符串原样（不加引号——命令、路径这类直接可读），
 * 其余 JSON 化（`safeStringify` 保证循环引用/BigInt 不炸），超长截断。截断标记用 `…`（末尾可见）。
 */
export function summarize(value, maxChars = DEFAULT_MAX_CHARS) {
    const text = typeof value === 'string' ? value : safeStringify(value);
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
