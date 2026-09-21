# pi-browser

浏览器等价的 pi coding agent **能力层**（纯库，无 UI、无产品语义）。Spice 是它的第一个消费者，反向依赖它。

设计文档：`spice/docs/superpowers/specs/2026-09-16-pi-browser-s1s3-design.md`（S1+S3/S4/S2.1 基座）、`spice/docs/superpowers/specs/2026-09-19-pi-browser-extension-api-alignment-design.md`（S6 扩展面接口级对齐，**取代** S5 的「工具注册」兼容面）。

## 当前状态

M8（v0.5.0）：S6 完成——**扩展面接口级对齐**：宿主类 `ExtensionRunner`（pi 同名）+ 扩展工厂 `(pi: ExtensionAPI) => void`，成员名/事件名逐字对齐 pi（支持面与不支持项清单见「扩展」节）；S5 自造的 `defineExtension`/`composeToolset`/`toHarnessTool` 已删（适配器降为内部件）。M7（v0.4.0）：S5 完成——扩展「工具注册」兼容面（已被 S6 取代）。M5（v0.3.0）：S4 完成（skills 加载/渲染 + compaction 接线与集成验证）+ S2.1 完成（通用宿主命令 seam：SAB 双端协议 + inline 同步路径）。M2 的七工具（`read`/`write`/`edit`/`grep`/`ls`/`find`/`bash`，fs 背书；名字 1:1 对齐上游 pi-coding-agent `core/tools/`，wire-level `name`/`label` 与公开 export 名全部一致）+ `createWasiFileSystem` + exec 接线 wasi-sh busybox（浏览器 worker / node inline 双轨，单写者同步）与 M1 的 S1+S3 基座（虚拟 FS + mount 路由 + 会话持久化）不变。

## 公开面 API

S1 五导出 + S2 七工具工厂 + S4 skills/compaction + S2.1 宿主命令 seam（`src/index.ts`）；消费者一律从包入口 import（浏览器产物面禁 deep import）。

| 导出 | 签名 | 用途 |
|---|---|---|
| `createBrowserFileSystem` | `(o?: BrowserFileSystemOptions) => BrowserFileSystem` | fs 工厂：**同 dbName 共享同一内核**（持久/自动内存均入注册表，同库多 cwd 视图同世界）；`memory: true` 每调用独立纯内存世界（隔离旋钮，不入注册表），`memory: false` 只用注册表内核（有 indexedDB 是 IDB 内核，无则为 MemoryBackend 内核，同 dbName 同世界） |
| `BrowserFileSystem` | `interface`（pi `FileSystem` + `flush(): Promise<void>`） | 会话持久化契约类型；`flush()` 兑现 lightning-fs 超级块 500ms debounce 之外的落盘 |
| `BrowserFileSystemOptions` | `{ dbName?: string; cwd?: string; memory?: boolean }` | fs 工厂选项（`dbName` 默认 `'spice-sessions'`） |
| `resetFsKernelRegistry` | `() => void` | **测试专用**：清空 fs 内核注册表（「同库新实例」durability 类测试清表后重开，断言的才是 IDB 落盘本身；生产禁用） |
| `normalizePath` | `(p: string) => string` | 纯 JS 路径归一（无 `node:path`，浏览器/Node 同构） |
| `createBrowserExecutionEnv` | `(o?: { dbName?; mounts?; shell?: 'busybox' \| false; workerUrl? }) => ExecutionEnv` | 默认挂载 `/`→IDB、`/tmp`→内存；`exec` 默认走 busybox（`shell: false` 退回 `shell_unavailable` 占位） |
| `MountEntry` | `{ prefix: string; fs: BrowserFileSystem }` | 挂载条目类型（挂载表 / shell 适配器的注入面） |
| `createWasiFileSystem` | `(store: { mounts: MountEntry[] }) => FileSystem` | wasi-sh 的同步 `FileSystem` 适配器（busybox guest 侧视图） |
| `createReadTool` | `(o: { fs: BrowserFileSystem; cwd?: string }) => AgentTool` | 读文本文件；offset/limit 分页；输出截 2000 行/50KB 并带 continuation 提示 |
| `createWriteTool` | 同上 | 覆盖写（自动建父目录），成功文案 `Successfully wrote to <path> (N bytes).` |
| `createEditTool` | 同上 | `edits: [{ oldText, newText }]` 精确替换（多命中报错并列位置；出 diff/patch） |
| `createGrepTool` | 同上 | 正则/字面量搜索：递归全目录 + `include` glob + 上下文行 + `file:line: text` 格式 |
| `createLsTool` | 同上 | 目录列表（`recursive?`），目录带尾斜杠、按名排序 |
| `createFindTool` | 同上 | picomatch glob 找文件（`*`/`?` 不跨 `/`，`**` 匹配多层）；工具 wire-level `name` = `find`（对齐上游） |
| `createBashTool` | `(o: { env: ExecutionEnv }) => AgentTool` | `{ command, timeout? }`（默认 30s）经 `env.exec` 跑 busybox；不支持项在 description 里如实声明；wire-level `name` = `bash`（对齐上游） |
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
| `ExtensionRunner` | `class`（`load(extensions)` / `getAllRegisteredTools()` / `getToolDefinition(name)` / `hooks` / `events` / `close()`） | S6 宿主：持有 `context` 与工具注册表，装载扩展并同步工具面（见「扩展」节） |
| `defineTool` | `<TParams, TDetails>(def: ToolDefinition<TParams, TDetails>) => ToolDefinition<TParams, TDetails>` | S6：上游同名辅助——顶住参数推断（赋给变量/进数组时 `params` 不被拓宽成 `unknown`） |
| `ExtensionAPI` / `ExtensionContext` / `ToolDefinition` / `Extension` / `ExtensionFactory` / `InlineExtension` / `ExtensionBindings` / `ExtensionRunnerOptions` / `SourceInfo` / `ToolInfo` / `EventBus` / `CompactOptions` / `ContextUsage` | 类型 | S6 扩展面（见「扩展」节；`harness-tool.ts` 适配器是内部件，不经入口导出） |

七工具形状同上游：typebox `parameters` + `label` + `description` + `execute(toolCallId, input, signal?, onUpdate?)`，**失败 throw**（fs 类错误带 `FileErrorCode`，shell 带 `ExecutionErrorCode`）。

```ts
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv, createBrowserFileSystem, createReadTool, createBashTool } from '@lixianmin/pi-browser';

const env = createBrowserExecutionEnv();                        // '/'→IDB（持久）、'/tmp'→内存（临时）
await env.writeFile('/spice-sessions/s1/main.jsonl', line, BACKGROUND_CONTEXT);
const tmp = await env.createTempDir(undefined, BACKGROUND_CONTEXT);   // 固定落 /tmp 挂载

const fs = createBrowserFileSystem({ dbName: 'spice-sessions' });      // 会话存储用这个（含 flush 契约）
await fs.flush();                                                     // 每回合末调用，否则刷新页面丢会话

const tools = [createReadTool({ fs }), createBashTool({ env })];      // 形状 = 上游 AgentTool[]：交给 Agent/AgentContext
                                                                      // （要进 AgentHarness 得用 toHarnessTool 适配，见「扩展」节）
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

## busybox（自带 wasm 与默认宿主命令）

`createBrowserExecutionEnv` 默认用**本包自带**的 `src/shell/busybox.wasm`，不是上游 wasi-sh 那份。原因有二，都是实测出来的：

1. 上游 `busybox.config` 裁掉了 `find` 的 `-path` / `-maxdepth` / `-mtime` / `-size` 等选项（`find: unrecognized: -path` 直接报错），且 `CONFIG_SHOW_USAGE` 关闭——此时 `--help` 会**静默 exit 0**（agent 以为拿到帮助了，其实什么都没有）。
2. 一批对 agent 常用的 applet（`base64` `diff` `patch` `bc` `tree` `tar` `cal` …）默认没编进去。

自带 wasm 的开启清单在 `scripts/busybox.config`（每个分组都注明**为什么砍掉某些选项**）。重建：

```sh
sh scripts/build-busybox.sh   # 需要 zig（brew install zig）；产物落到 src/shell/busybox.wasm
```

脚本会一并链接 `scripts/pi-wasi-stubs.c`：开了更多 applet 后会引入 wasi-libc / wasi-sh 都没实现的符号，而链接用 `--import-undefined`，不补桩就会在 `WebAssembly.instantiate()` 抛 `function import requires a callable`。

**能用的边界**（都实测过，不是推测）：wasi-sh 是 fork-free 的单进程 shell，所以

- **压缩解压不可用**（`gzip` `bzip2` `xz` `lzma` …）：busybox 的 `bbunzip` 在**进程内**把 fd 0/1 重定向（`xmove_fd` / `open_to_or_warn(STDOUT_FILENO,…)`），在共享 fd 模型下会把 shell 自己的 stdout 永久改到输出文件上——下一个 `echo` 就报 `Bad file descriptor`。同类问题也砍掉了 `dd` 与 `split`。
- **需要 fork 的写法不可用**：`tar -z`、`zcat`、`diff <(a) <(b)`（进程替换）会报 `fork: Function not implemented`。
- **改文件元数据的命令不可用**：`chmod` `ln` `truncate` `shred`（wasi 没有 `chmod`/`link`/`truncate` syscall）。这些命令干脆不编进来——工具箱的原则是「present 即可用」，留着只会让 agent 白撞。
- `cp -r` / `install` 可用，只在「保留权限」这步往 stderr 告警。

### 默认宿主命令：`which` / `mount`

这两个由 pi-browser 默认注册（`createBrowserExecutionEnv` 里 `{...默认, ...调用方给的}`，同名以调用方为准）：

- **`which`**：busybox 自带的 `which` 走 `find_executable()`（`access(X_OK)` + `stat` + `S_ISREG`），是**纯文件查找**，从不查 applet 表——平时能用只是因为 busybox 安装时造了 `/bin/ls -> /bin/busybox` 符号链接；wasi-sh 是单个 `.wasm`、从不 `make install`，于是 `which ls` 找不到自己的 applet（实测 exit 1）。所以这里的 `which` 对齐 `command -v` 语义：shell 可解析的名字（applet / 内建 / 宿主命令）直接命中并打印名字本身，否则沿 `$PATH` 找常规文件。
- **`mount`**：busybox 的 `mount` 要真实 mount syscall 或 `/proc/mounts`，wasi 里都没有，编进来也是哑炮。这里实现「无参 `mount`」语义：列出挂载表（`/ on browser-fs`、`/tmp on browser-fs`）。

两个命令都要读 FS / 挂载表，因此**只在 worker 路径生效**；node/vitest 的 inline 路径会明确报错（与其它宿主命令的约束一致）。

若要换用别处的 wasm，用 `createBrowserExecutionEnv({ wasm })`（`URL | string | ArrayBuffer | Uint8Array | WebAssembly.Module`）。

## 扩展（宿主 API 同名同形）

**S6 的口径：接口级一模一样。** 对外面只出现 pi coding agent 的同名成员；浏览器做不到的成员**保留原名、明确列不支持**，不造「差不多」的名字。名单与裁决的真源在 `src/extensions/contract.ts`，并有对照测试钉住（`test/extensions-contract.test.ts` 逐字比对上游三张名单，上游升级时会红；事件类型表与「支持」名单的键集合也由那里双向钉住——任一边多出/漏掉一个名字，`tsc` 直接报出差异的名字）。

扩展是**宿主自己的代码**（浏览器原生对象，不经加载器、不做发现），与宿主**同权限**——它不是沙箱，别拿它当隔离边界。

```ts
import { Type } from 'typebox';
import { ExtensionRunner, defineTool } from '@lixianmin/pi-browser';

const echo = (pi: ExtensionAPI) => {                       // 扩展 = 工厂（pi 的形状）
  pi.registerTool(defineTool({
    name: 'Echo',
    label: 'Echo',                                         // label 必填（与 pi 一致，不做缺省归一）
    description: '回显 text 参数',
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_toolCallId, input, _signal, _onUpdate, ctx) =>
      ({ content: [{ type: 'text', text: `${ctx.cwd}: ${input.text}` }], details: undefined }),
  }));
  pi.on('tool_call', (event) => { /* 可 block：阶段 4 的越权拒绝落点 */ });
};

const runner = new ExtensionRunner({ harness, lane, context, cwd: '/projects/x', thinkingLevel: 'medium' });
await runner.load([{ name: 'demo-echo', factory: echo }]);  // 装载后自动同步 harness.setTools + lane.setActiveTools
```

### 支持的 API 成员（14）

`on` / `registerTool` / `getActiveTools` / `getAllTools` / `setActiveTools` / `events` / `appendEntry` / `sendUserMessage` / `setSessionName` / `getSessionName` / `setLabel` / `setModel` / `getThinkingLevel` / `setThinkingLevel`

- **同步/异步错位已记账**：pi 的 `getSessionName` / `getThinkingLevel` / `getActiveTools` 是同步值，而 pi-agent-core 的对应调用是 `Promise`——宿主持已知值缓存，同步 getter 读缓存（绕过 API 外部改值的场景不在本仓用例内）。
- **注册期锁**：扩展工厂里调用运行期成员会**响亮抛错**（对齐 pi 的 `assertActive()`）；`close()` 后再次锁死。

### 不支持的 API 成员（12，保留原名）

- 无 slash 命令面 / 无 TUI：`registerCommand` / `getCommands` / `registerShortcut` / `registerFlag` / `getFlag` / `registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer`
- 本仓无对应物，不发明形状：`registerProvider` / `unregisterProvider`（provider 由 app 配置）/ `exec`（pi 的 `ExecResult` 与 pi-agent-core 的 `Result` 形状映射未核实）/ `sendMessage`（pi 的 `display` 是 TUI 渲染函数，进不了 `JsonValue`）

### `ExtensionContext`：支持 5 / 不支持 12

- **支持**：`cwd` / `model` / `signal`（**本次调用**的信号）/ `abort()` / `compact()`
- **不支持**：TUI 与宿主进程概念（`ui` / `mode` / `hasUI` / `isProjectTrusted` / `shutdown`）；**同步/异步错位**（`isIdle` / `getContextUsage` / `getSystemPrompt`——上游是同步值，harness 侧是 `Promise`）；上游 CLI 专属复合对象（`sessionManager` / `modelRegistry` / `scopedModels`）；本仓无对应操作（`hasPendingMessages`）

### 事件：`on(event, handler)` 支持 25 / 不支持 11

**事件名是封闭集合，编译期就拦住。** `ExtensionAPI.on` 的签名是 `on<E extends keyof ExtensionEventMap>(event, handler)`——支持的事件名有补全，不支持/写错的名字**编不过**，不用等到运行期。载荷与返回值类型取自 **pi-agent-core 的实际交付**，不是 pi 的同名事件类型（两者形状确实不同：`tool_call` 交付的是 `{toolCallId, toolName, args, lane, runId}`，而 pi 的 `ToolCallEvent` 是 `{type, toolCallId, toolName, input}`；`session_start` 只有 `type`，pi 的还有 `reason`）——拿 pi 的类型标注这些 handler 等于给使用者假信息。

```ts
pi.on('tool_call', (event) => {            // event.args: Record<string, JsonValue>，event.toolName: string
  if (event.toolName === 'Write') return { block: { reason: '越权' } };   // 返回值同源：before_tool 的 result
});
pi.on('ui_prompt_start', () => {});        // 编译错误：不支持的事件名
```

支持项按 pi 事件名逐条映射到 pi-agent-core 的 hooks / events（`tool_call`→`before_tool`、`tool_result`→`after_tool`、`context`→`transform_context`、`agent_start`→`run_start`、`agent_end`→`run_end`、`turn_start`/`turn_end`、`message_*`、`tool_execution_*`、`session_before_compact`→`before_compaction`、`session_compact`→`compaction_end`、`session_before_tree`→`before_navigation`、`session_tree`→`navigation_end`、`model_select`/`thinking_level_select`→`config_update`（按 `property` 过滤）、`before_provider_request`/`before_provider_headers`→`before_request`、`after_provider_response`→`after_response`、`session_start`/`session_shutdown` 由宿自己发）。

不支持（**编译期**拒，且注册期运行期也会抛、错误消息列支持清单）：`project_trust` / `resources_discover` / `session_info_changed` / `session_before_switch` / `session_before_fork` / `session_compact_failed` / `ui_prompt_start` / `ui_prompt_end` / `user_bash` / `input` / `agent_settled`。

### 工具重名

**后写覆盖先写**（对齐 pi 宿主的 Map 语义），差异只有一行 `console.warn`（黄线：本仓有「静默失效比报错更糟」的教训，但不新增自造接口名来承载告警）。S5 的「默认抛错 + `overrideBuiltins` 白名单」是自造行为，已删。

### 仍不做

TS/jiti 加载、`~/.pi` 与 `.pi` 目录发现、项目信任门、`/reload` 热重载、终端 UI（见上文「不支持」清单的理由）。

## 开发

```sh
bun install && bunx vitest run
```

## 浏览器部署

Shell 能力（busybox exec）的 worker 路径依赖 `SharedArrayBuffer`：宿主页面需带 COOP/COEP 响应头（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`），并把 `@lixianmin/pi-browser/shell/worker` 打包为 worker 入口传给 `createBrowserExecutionEnv({ workerUrl })`。Node/测试环境走 inline 路径，无此要求（硬超时仅在 worker 路径生效）。
