# pi-browser

浏览器等价的 pi coding agent **能力层**（纯库，无 UI、无产品语义）。Spice 是它的第一个消费者，反向依赖它。

设计文档：`spice/docs/superpowers/specs/2026-09-16-pi-browser-s1s3-design.md`。

## 当前状态

M2：S2 完成（v0.2.0）——七工具（`Read`/`Write`/`Edit`/`Grep`/`Ls`/`Glob`/`Shell`，fs 背书）+ `createWasiFileSystem` 适配器 + exec 接线 wasi-sh busybox（浏览器 worker / node inline 双轨，spec §3.2 单写者同步）。M1 的 S1+S3 基座（虚拟 FS + mount 路由 + 会话持久化）不变。S4（skills/compaction）、S5（extensions 兼容面）未开始。

## 公开面 API

S1 五导出 + S2 七工具工厂 + 适配器/挂载类型（`src/index.ts`）；消费者一律从包入口 import（浏览器产物面禁 deep import）。

| 导出 | 签名 | 用途 |
|---|---|---|
| `createBrowserFileSystem` | `(o?: BrowserFileSystemOptions) => BrowserFileSystem` | fs 工厂：默认 lightning-fs/IDB；`memory: true` 强制内存后端，`memory: false` 强制走 IDB |
| `BrowserFileSystem` | `interface`（pi `FileSystem` + `flush(): Promise<void>`） | 会话持久化契约类型；`flush()` 兑现 lightning-fs 超级块 500ms debounce 之外的落盘 |
| `BrowserFileSystemOptions` | `{ dbName?: string; cwd?: string; fs?: LightningFS; memory?: boolean }` | fs 工厂选项（`dbName` 默认 `'spice-sessions'`） |
| `normalizePath` | `(p: string) => string` | 纯 JS 路径归一（无 `node:path`，浏览器/Node 同构） |
| `createBrowserExecutionEnv` | `(o?: { dbName?; mounts?; shell?: 'busybox' \| false; workerUrl? }) => ExecutionEnv` | 默认挂载 `/`→IDB、`/tmp`→内存；`exec` 默认走 busybox（`shell: false` 退回 `shell_unavailable` 占位） |
| `MountEntry` | `{ prefix: string; fs: BrowserFileSystem }` | 挂载条目类型（挂载表 / shell 适配器的注入面） |
| `createWasiFileSystem` | `(store: { mounts: MountEntry[] }) => FileSystem` | wasi-sh 的同步 `FileSystem` 适配器（busybox guest 侧视图） |
| `createReadTool` | `(o: { fs: BrowserFileSystem; cwd?: string }) => AgentTool` | 读文本文件；offset/limit 分页；输出截 2000 行/50KB 并带 continuation 提示 |
| `createWriteTool` | 同上 | 覆盖写（自动建父目录），成功文案 `Successfully wrote to <path> (N bytes).` |
| `createEditTool` | 同上 | `edits: [{ oldText, newText }]` 精确替换（多命中报错并列位置；出 diff/patch） |
| `createGrepTool` | 同上 | 正则/字面量搜索：递归全目录 + `include` glob + 上下文行 + `file:line: text` 格式 |
| `createLsTool` | 同上 | 目录列表（`recursive?`），目录带尾斜杠、按名排序 |
| `createGlobTool` | 同上 | picomatch glob 找文件（`*`/`?` 不跨 `/`，`**` 匹配多层） |
| `createShellTool` | `(o: { env: ExecutionEnv }) => AgentTool` | `{ command, timeout? }`（默认 30s）经 `env.exec` 跑 busybox；不支持项在 description 里如实声明 |

七工具形状同上游：typebox `parameters` + `label` + `description` + `execute(toolCallId, input, signal?, onUpdate?)`，**失败 throw**（fs 类错误带 `FileErrorCode`，shell 带 `ExecutionErrorCode`）。

```ts
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv, createBrowserFileSystem, createReadTool, createShellTool } from '@lixianmin/pi-browser';

const env = createBrowserExecutionEnv();                        // '/'→IDB（持久）、'/tmp'→内存（临时）
await env.writeFile('/spice-sessions/s1/main.jsonl', line, BACKGROUND_CONTEXT);
const tmp = await env.createTempDir(undefined, BACKGROUND_CONTEXT);   // 固定落 /tmp 挂载

const fs = createBrowserFileSystem({ dbName: 'spice-sessions' });      // 会话存储用这个（含 flush 契约）
await fs.flush();                                                     // 每回合末调用，否则刷新页面丢会话

const tools = [createReadTool({ fs }), createShellTool({ env })];      // 交给 AgentHarness 注册
tools[0].parameters;                                                  // typebox schema（校验由上游做）
```

## 开发

```sh
bun install && bunx vitest run
```
