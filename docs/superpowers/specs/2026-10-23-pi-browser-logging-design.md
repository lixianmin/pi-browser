# pi-browser 日志面设计（needle）

日期：2026-10-23　状态：已实现（本 spec 是实现依据）

## 1. 背景与目标

本仓此前几乎没有日志：`src/` 里只有两处 `console.warn`（扩展 runner 的两处告警），其余关键路径
（工具调用、shell 执行、文件写入）全无痕迹。排障时只能靠复现 + 打断点，而浏览器端的 fs / shell /
工具链一旦出错，**错在哪一步**往往就是唯一有用的信息。

目标：给本仓一条**结构化、可被宿主接管**的日志通道——库自己写日志，宿主决定日志去哪（控制台 / 文件 /
飞书 / 自己的 sink），两边用同一套库（needle），不各自造轮子。

## 2. 选型：needle（`@needle/logo`）

用同机已有的 `needle` 仓（`/Users/xmli/me/code/needle`，包名 `@needle/logo`）：

- **零运行时依赖**：core 入口不拉 `node:fs`（file sink 只从 `@needle/logo/node` 导出），浏览器可用。
- **sink 可插**：`logo.addSink(sink)` 挂文件 / 飞书 / 自定义；宿主想接管本仓日志，挂到本仓导出的
  logger 上即可，不必改本仓代码。
- **结构化记录**：`LogRecord` 是 JSON 安全的（循环引用、BigInt、抛异常的 getter 都被 sanitize 过），
  不需要各调用点自己转字符串。
- **house pattern**：`video.downloader` 已经用同一套（依赖写法 `github:lixianmin/needle#main`），
  同一台机器上两边的日志形态、sink 用法一致。

不用 `console.*` 直接写：没有级别、没有结构化字段、宿主接不走。

依赖写法与 `video.downloader` 同口径：`"@needle/logo": "github:lixianmin/needle#main"`（lockfile 钉到
具体 sha）。needle 的 `dist/` 随源码提交进仓（needle 侧的决定），所以 git 依赖不需要消费者构建。

## 3. 日志面：`src/logging.ts`（全仓唯一入口）

```ts
export const logger: Logger = newLogger({ name: 'pi-browser', level: 'info', sinks: [stdoutSink] });
```

- **实例自己造，不复用 needle 的全局 `logo`**：`child()` 会**快照**父级 sink（needle 的实现如此），
  模块加载时建好的 child 拿不到宿主后挂的 sink。自己造实例并从公开面导出，宿主挂 sink 才有的放矢。
- **默认带 stdout sink**：浏览器里落 `console`、Node 里落 stdout——库开箱就有可观测性，宿主不必先接线。
  `stdoutSink` 走 needle 自带的 `hasStdout()` 能力探测，浏览器里退化为逐条 `console.log`。
- **默认级别 `info`**：`debug` 收细节（参数、路径），`info` 收关键动作（工具调用、命令执行、写盘），
  `warn` / `error` 收失败。宿主要更安静就 `logger.setLevel('warn')`，要更吵就 `logger.setLevel('debug')`。
- **公开面导出 `logger`**：宿主 `import { logger } from '@lixianmin/pi-browser'` 后
  `logger.addSink(createFileSink({ dir: 'logs' }))` 即可接管本仓全部日志。

字段口径（needle 的 `buildRecord` 规则）：字符串拼进 `msg`，纯对象并入记录字段，`Error` 展开成
`message` + `stack`；`time` / `level` / `msg` / `name` 是信封，业务字段不能覆盖。

## 4. 打点表（收口点，不散落）

| 位置 | 级别 | 内容 | 为什么是这一处 |
|---|---|---|---|
| `src/tools/durable-tool.ts` `execute` | info | 工具名 + 参数摘要 + 耗时 + 成败 | 七工具在 durable 编排下的**唯一**执行收口：一处覆盖全部工具调用 |
| `src/shell/exec.ts` `exec` | info | 命令 + cwd + 退出码/错误码 + 耗时 | shell 的收口；早退（cleanup 后、argv 不支持、非法 timeout）也在同一层被记到 |
| `src/tools/fs-ops.ts` `writeText` | info | 路径 + 字节数 | 本仓唯一的写文件收口（write / edit 两个工具都走它） |
| `src/extensions/runner.ts` 两处 `console.warn` | warn | 原文案不变 | 替换掉裸 `console.warn`，让扩展告警也进同一条通道 |
| `src/session/harness.ts` `openBrowserHarness` | info | 打开成功/失败 | 会话装配的边界：起不来时第一眼能看到 |

参数摘要要**截断**：工具入参可能含整个文件内容（`write` 的 `content`），原样进日志既刷屏又可能泄密。
统一走 `summarize()`（`src/logging.ts`）：截到 500 字符，超出以 `…` 结尾。

## 5. 不做的事

- 不做采样、不做脱敏、不做远程上报——宿主要的话自己挂 sink 处理。
- 不引 node 侧 file sink（浏览器库，`@needle/logo/node` 依赖 `node:fs`）；宿主在 node 侧自行挂。
- 不改公开面以外的 API：`logger` 是**新增**导出，其余导出不动（`test/public-surface.test.ts` 的
  运行时导出表同步加一条）。

## 6. 验收

- `test/logging.test.ts`：挂采集 sink，断言四处打点各自产出预期记录（级别 / 字段）。
- `bunx tsc --noEmit`（主包 + debugger）0 错；主包与 debugger 测试全绿；`lib/` 重建后与源码一致
  （`test/lib-in-sync.test.ts` 按字节比对）。
