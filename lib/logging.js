// src/logging.ts —— 本仓日志面（needle `@needle/logo`）的全仓唯一入口。
//
// 为什么用 needle 而不是 console：库自己写日志、宿主决定日志去哪（文件 / 飞书 / 调试控制台），
// 这需要「级别 + 结构化字段 + 可插 sink」三样东西，`console.*` 一样都没有。needle 是同机已有的库
// （`/Users/xmli/me/code/needle`），零运行时依赖、浏览器可用，`video.downloader` 已在用同一套。
// 设计依据见 `docs/superpowers/specs/2026-10-23-pi-browser-logging-design.md`。
//
// **用 needle 导出的全局 `logo` 本身，不再另造实例。** 需求是「全应用唯一一个 logger」：宿主
// `logo.addSink(createFileSink(...))` 一处挂载，本仓与宿主的日志一起落盘，级别也是同一个旋钮。
// 之前一版另造了 `newLogger({ name: 'pi-browser' })`，理由是「怕出现两个 logo」——实测站不住：
//
//   · bun 去重按**解析结果**，不按 spec 字符串。两方 spec 分别是 `#main` 与 `#7622cab`、而 main
//     当时正好是 7622cab 时，只装一份物理副本，两个依赖方符号链接到同一个 store 目录
//     → 一个模块实例 → 一个 `logo`。
//   · 只有两方 lockfile 解析到**不同 sha**（升级窗口期的错配）才会出现两份副本；那两份各自都带
//     `stdoutSink`，都往同一个 console 写，输出不丢。丢的只是「宿主挂在它那份上的 file sink 收不到
//     本仓日志」——这是宿主侧配置问题，而且和「本仓另造实例」的结果一样（另造实例时宿主也必须
//     单独往我们的实例上挂 sink），并不能靠分裂实例改善。
//
// 代价（有意的，不是疏漏）：记录不带 `name` 字段；`setLevel` 是全局的（宿主调 warn，本仓 info 一起关）。
// 这两条正是「唯一实例」想要的语义。需要单独档位时应由宿主的 sink 侧过滤，而不是再造一个 logger。
import { logo, safeStringify } from '@needle/logo';
/** 本仓日志器 = needle 的全局实例（宿主 `addSink` / `setLevel` 即接管全部日志，含本仓的）。 */
export const logger = logo;
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
