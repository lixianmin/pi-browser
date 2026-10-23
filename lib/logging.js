// src/logging.ts —— 本仓日志面（needle `@needle/logo`）的全仓唯一入口。
//
// 为什么用 needle 而不是 console：库自己写日志、宿主决定日志去哪（文件 / 飞书 / 调试控制台），
// 这需要「级别 + 结构化字段 + 可插 sink」三样东西，`console.*` 一样都没有。needle 是同机已有的库
// （`/Users/xmli/me/code/needle`），零运行时依赖、浏览器可用，`video.downloader` 已在用同一套。
// 设计依据见 `docs/superpowers/specs/2026-10-23-pi-browser-logging-design.md`。
//
// 为什么自己造实例、而不是用 needle 导出的全局 `logo`：三条，缺一不可。
//
//   ① **模块身份不等于包名。** ESM 的模块身份是解析后的**文件路径**，同一个包存在两份物理副本就有两个
//      模块实例，模块顶层的 `export const logo = newLogger(...)` 就执行两次 → 两个 `logo`。bun 按
//      「包名@spec」分副本，所以宿主写 `#main`、本仓写某个 sha 时就会各拿一份。后果是**静默丢日志**：
//      宿主往它那份 `logo` 挂文件 sink，本仓的日志走另一份的 stdout，宿主永远收不到，也不报错。
//      宿主装几份 needle、钉哪个 sha 是宿主的事，本仓控制不了；能控制的只有「把要用的 logger **对象**
//      直接交给宿主」——所以从公开面导出 `logger`，宿主拿到的是同一个引用，不依赖模块同一性。
//   ② **名字与级别要分开。** 全局 `logo` 没设 name（记录里就没有 `name` 字段，混在其它库的记录里分不出
//      哪条是本仓的），且 `setLevel` 是共享状态（宿主调 debug 会把本仓 info 一起改，反之亦然）。
//      自己造实例：每条记录带 `name: 'pi-browser'`，级别互不干扰。
//   ③ **「用 `logo` 再派生 child」这条路本身不通。** `child()` 是 `sinks: [...sinks]`（`core/logo/logo.ts`）
//      ——创建那一刻复制一份 sink **数组**，之后与父级解绑，宿主后挂的 sink 永远进不了已存在的 child。
//      所以要么直接用 `logo` 本身（回到 ① ②），要么自己造实例。
//
// 代价：宿主要多写一行 `import { logger } from '@lixianmin/pi-browser'` 再 `addSink`，
// 而不是往自己那份 `logo` 上挂（README「日志」节写了这个用法）。
//
// 默认带 stdout sink：浏览器里落 `console`、Node 里落 stdout（needle 的 `hasStdout()` 能力探测），
// 开箱就有可观测性；宿主要更安静就 `logger.setLevel('warn')`。
import { newLogger, safeStringify, stdoutSink } from '@needle/logo';
/** 本仓日志器：宿主从公开面拿到它，`addSink` 挂自己的 sink 即接管本仓全部日志。 */
export const logger = newLogger({ name: 'pi-browser', level: 'info', sinks: [stdoutSink] });
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
