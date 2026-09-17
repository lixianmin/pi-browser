# pi-browser

浏览器等价的 pi coding agent **能力层**（纯库，无 UI、无产品语义）。Spice 是它的第一个消费者，反向依赖它。

设计文档：`spice/docs/superpowers/specs/2026-09-16-pi-browser-s1s3-design.md`。

## 当前状态

M5（v0.3.0）：S4 完成（skills 加载/渲染 + compaction 接线与集成验证）+ S2.1 完成（通用宿主命令 seam：SAB 双端协议 + inline 同步路径）。M2 的七工具（`Read`/`Write`/`Edit`/`Grep`/`Ls`/`Glob`/`Shell`，fs 背书）+ `createWasiFileSystem` + exec 接线 wasi-sh busybox（浏览器 worker / node inline 双轨，单写者同步）与 M1 的 S1+S3 基座（虚拟 FS + mount 路由 + 会话持久化）不变。S5（extensions 兼容面）未开始。

## 公开面 API

S1 五导出 + S2 七工具工厂 + S4 skills/compaction + S2.1 宿主命令 seam（`src/index.ts`）；消费者一律从包入口 import（浏览器产物面禁 deep import）。

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
| `loadBrowserSkills` | `(o?: { dbName?; mounts?; roots? }) => Promise<{ skills; diagnostics }>` | 自建 env 跑上游 `loadSkills`；默认 roots `['/skills','/.pi/skills']` |
| `loadSkillsFromEnv` | `(env: ExecutionEnv, roots?: string[]) => Promise<{ skills; diagnostics }>` | 在已有 env 上加载（已有 IDB 会话时不必再建一个） |
| `formatSkillsForSystemPrompt` | `(skills: Skill[]) => string` | 上游 re-export：清单块（含 `<location>`，过滤 `disableModelInvocation`） |
| `formatSkillInvocation` | `(skill: Skill, additionalInstructions?) => string` | 上游 re-export：按需调用块 |
| `createCompactionSummaryMessage` | `(summary, tokensBefore, timestamp) => CompactionSummaryMessage` | 上游 re-export：`compaction` 条目的消息投影（role `compactionSummary`） |
| `DEFAULT_COMPACTION_SETTINGS` | `{ enabled; reserveTokens; keepRecentTokens }` | 上游默认值（`reserveTokens: 16384`——小 `contextWindow` 必须显式收窄，见下） |
| `createBrowserExecutionEnv`（续） | `hostCommands?: Record<string, HostCommandHandler>` | 宿主命令注册表（见「宿主命令」节） |
| `createHostCommandChannel` | `(sab: SharedArrayBuffer, o?: { timeoutMs? }) => { hostSide; guestSide }` | SAB/futex 双端协议（可脱离 exec 自建宿主/单测） |
| `createHostCommandSharedBuffer` | `(o?: { capacity? }) => SharedArrayBuffer` | 按容量分配通道内存（默认 8MB/方向） |
| `createHostCommandResponder` | `(store: { mounts }, handlers) => HostCommandResponder` | 宿主侧 glue：§3.3 对账 + 派发处理器 |
| `createGuestHostBuiltins` | `(guestFs, guestSide, names) => HostBuiltins` | guest 侧 glue：把宿主命令装成 wasi-sh builtins（worker 内） |

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

## skills 与 compaction（S4）

- **skills**：加载用 `loadBrowserSkills(o?)`（自建 ExecutionEnv）或 `loadSkillsFromEnv(env, roots?)`（复用已有 env）——都是上游 `loadSkills` 的薄封装，默认 roots `['/skills', '/.pi/skills']`，`diagnostics` 原样透出。清单渲染用上游 `formatSkillsForSystemPrompt(skills)`（含 `<location>`、过滤 `disableModelInvocation`），按需调用块用 `formatSkillInvocation(skill)`；产物直接放进 `AgentHarnessResources.skills`。发现/校验规则（`SKILL.md`、frontmatter、忽略文件）全归上游，本库不复刻。
- **compaction**：本库**不直接调** `compact`/`prepareCompaction`（那两条会引入 pi-ai 运行时依赖）。`AgentHarness` 自带自动压缩，由构造选项 `compaction: CompactionSettings` 驱动，产物是会话里的 `compaction` 条目（`summary` + `retainedTail`）；事件面 `compaction_start`/`compaction_end`（`reason: manual | threshold | overflow`），`before_compaction` 钩子可返回 `{ decline: true }` 拦截。
- **必须显式给设置**：上游默认 `DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`。`contextWindow` 小于 `reserveTokens` 时必须自己收窄 `reserveTokens`，否则 `contextWindow - reserveTokens` 为负、阈值恒真（每轮都压）。实测（`test/compaction-integration.test.ts`）：`contextWindow: 2048` + `{ enabled: true, reserveTokens: 256, keepRecentTokens: 128 }`，两轮各约 700 token 的对话即触发 `reason: "threshold"`，产出 `retainedTail` 非空的 `compaction` 条目。

## 宿主命令（S2.1）

宿主可以注册新的 shell 命令（名字 → JS 处理器），guest 像 applet 一样调用它们（可被管道/重定向/`$()`/`if` 组合）。seam 与具体命令无关（spice 的 `git` 只是第一个消费者）。

```ts
const env = createBrowserExecutionEnv({
  workerUrl: new URL('@lixianmin/pi-browser/shell/worker', import.meta.url),   // 浏览器路径
  hostCommands: {
    // 处理器在**主线程**执行，允许 async（这是 seam 的价值：宿主可以用任意异步库）
    countBytes: async (req, fs) => {
      const text = await fs.readTextFile(req.args[0] ?? '/dev/null', BACKGROUND_CONTEXT);
      if (!text.ok) return { exitCode: 1, stderr: `${text.error.code}: ${req.args[0]}\n` };
      return { exitCode: 0, stdout: `${text.value.length}\n` };
    },
  },
});
// guest：`countBytes /a.txt | wc -c`
```

- **权限边界**：处理器跑在**宿主权限**下（可读写权威 FS、可发网络请求）——它等价于「宿主自己写的代码」，不是沙箱逃生；guest 侧拿不到任何额外权限。
- **名字**：与 busybox applet / ash 内建同名（`ls`、`cd`、`grep`…）在创建 env 时**抛错**——ash 先解析 applet，注册了也永远轮不到你（静默失效比报错更糟）。新名字（如 `git`）照常。
- **两条路径**：浏览器（worker）走 SAB 通道，处理器可 async、可读写权威 FS；node/vitest（inline）**只支持同步纯处理器**——没有第二个线程可停靠，异步处理器与任何 `fs` 访问都会明确报错（有 FS 效果的命令必须走 worker 路径）。
- **FS 对账**（单写者协议的延伸，S2.1 §3.3）：每次调用前把 guest 变更集落进权威 store（+flush）→ 处理器直接读写权威 store → 返回后把 store 的净变化推回 worker 内缓存。因此处理器看得到 guest 刚写下的内容，guest 也立即读得到处理器的写；IDB 仍然只由主线程写。
- **上限**：SAB 定长 8MB/方向；应答超出 → 截断 stdout 并在 stderr 追加说明，变更集本身超出则该次应答失败（exitCode 1）。请求超出同样失败。
- **stdin**：本 shell 没有活 stdin（exec 从不写 stdin），fd 0 恒 EOF；`echo x | hostcmd` 走管道 fd、`hostcmd < f` 走文件 fd，都照常读到。处理器拿到的 `stdin` 在无输入时是 `undefined`。
- **超时**：guest 等待宿主应答的上限取 exec 的 `timeout`（未设 30s）；真正卡死仍由 exec 既有硬杀语义收尾（返回 `timeout`）。

## 开发

```sh
bun install && bunx vitest run
```

## 浏览器部署

Shell 能力（busybox exec）的 worker 路径依赖 `SharedArrayBuffer`：宿主页面需带 COOP/COEP 响应头（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`），并把 `@lixianmin/pi-browser/shell/worker` 打包为 worker 入口传给 `createBrowserExecutionEnv({ workerUrl })`。Node/测试环境走 inline 路径，无此要求（硬超时仅在 worker 路径生效）。
