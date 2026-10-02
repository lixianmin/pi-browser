# pi-browser

浏览器等价的 pi coding agent **能力层**（纯库，无 UI、无产品语义）。Spice 是它的第一个消费者，反向依赖它。

设计文档：`spice/docs/superpowers/specs/2026-09-16-pi-browser-s1s3-design.md`（S1+S3/S4/S2.1 基座）、`spice/docs/superpowers/specs/2026-09-19-pi-browser-extension-api-alignment-design.md`（S6 扩展面接口级对齐，**取代** S5 的「工具注册」兼容面）。

## 当前状态

M9（v1.0.0）：**pi-coding-agent 1.0.0 对齐完成**——依赖从 0.99.1 升到 1.0.0（`pi-agent-core` 在 1.0.0 只剩 agent / agent-loop / proxy / stream-fn / types 五个模块，`harness/`、`JsonlSessionRepo`、`harness/compaction` 整块消失）；七工具换成上游的「两导出 + operations 缝」并逐字对齐静态契约面（schema / description / snippet / guidelines 由测试直接 import 上游 `createXToolDefinition` 比对）；共享件 `truncate` / `path-utils` / `edit-diff` 逐字转写；扩展宿主换注入模型（`createExtensionRuntime` + `runner.bindCore(actions, contextActions)`，事件由宿主在对应时机调 runner 的 `emit` / 具名 `emitXxx`，25 条事件各有逐路由触发测试）；skills 改名 `formatSkillsForPrompt` + compaction 自持（1.0.0 把它搬进 CLI 仓）；会话格式对照落到 v3 JSONL + 上游纯函数（1.0.0 的 `SessionManager` 是 node:fs 绑定 + 私有构造，喂不进浏览器 fs）。**破坏性变更清单**见「公开面 API」表与「平台偏差」节（D1–D8）——其中 `createCompactionSummaryMessage` 的 `timestamp` 从 `string | number` 收窄为 `string`，扩展 handler 的载荷类型从 core 的形状换成上游 pi 事件的形状（`tool_call` 的 `args` → `input`、`session_start` 多必填 `reason`）。M8（v0.5.0）：S6 完成——**扩展面接口级对齐**：宿主类 `ExtensionRunner`（pi 同名）+ 扩展工厂 `(pi: ExtensionAPI) => void`，成员名/事件名逐字对齐 pi（支持面与不支持项清单见「扩展」节）；S5 自造的 `defineExtension`/`composeToolset`/`toHarnessTool` 已删（适配器降为内部件）。M7（v0.4.0）：S5 完成——扩展「工具注册」兼容面（已被 S6 取代）。M5（v0.3.0）：S4 完成（skills 加载/渲染 + compaction 接线与集成验证）+ S2.1 完成（通用宿主命令 seam：SAB 双端协议 + inline 同步路径）。M2 的七工具（`read`/`write`/`edit`/`grep`/`ls`/`find`/`bash`，fs 背书；名字 1:1 对齐上游 pi-coding-agent `core/tools/`，wire-level `name`/`label` 与公开 export 名全部一致）+ `createWasiFileSystem` + exec 接线 wasi-sh busybox（浏览器 worker / node inline 双轨，单写者同步）与 M1 的 S1+S3 基座（虚拟 FS + mount 路由 + 会话持久化）不变。

## 公开面 API

S1 五导出 + S2 七工具工厂 + S4 skills/compaction + S2.1 宿主命令 seam + 批 2 的 pi-durable 接线（`src/index.ts`）；消费者一律从包入口 import（浏览器产物面禁 deep import）。

| 导出 | 签名 | 用途 |
|---|---|---|
| `createBrowserFileSystem` | `(o?: BrowserFileSystemOptions) => BrowserFileSystem` | fs 工厂：**同 dbName 共享同一内核**（持久/自动内存均入注册表，同库多 cwd 视图同世界）；`memory: true` 每调用独立纯内存世界（隔离旋钮，不入注册表），`memory: false` 只用注册表内核（有 indexedDB 是 IDB 内核，无则为 MemoryBackend 内核，同 dbName 同世界） |
| `BrowserFileSystem` | `interface`（pi `FileSystem` + `flush(): Promise<void>`） | 会话持久化契约类型；`flush()` 兑现 lightning-fs 超级块 500ms debounce 之外的落盘 |
| `BrowserFileSystemOptions` | `{ dbName?: string; cwd?: string; memory?: boolean }` | fs 工厂选项（`dbName` 默认 `'spice-sessions'`） |
| `resetFsKernelRegistry` | `() => void` | **测试专用**：清空 fs 内核注册表（「同库新实例」durability 类测试清表后重开，断言的才是 IDB 落盘本身；生产禁用） |
| `normalizePath` | `(p: string) => string` | 纯 JS 路径归一（无 `node:path`，浏览器/Node 同构） |
| `createBrowserExecutionEnv` | `(o?: { dbName?; mounts?; shell?: 'busybox' \| false; workerUrl?; wasm?; hostCommands? }) => ExecutionEnv` | 默认挂载 `/`→IDB、`/tmp`→内存；`exec` 默认走 busybox（`shell: false` 退回 `shell_unavailable` 占位） |
| `MountEntry` | `{ prefix: string; fs: BrowserFileSystem }` | 挂载条目类型（挂载表 / shell 适配器的注入面） |
| `createWasiFileSystem` | `(store: { mounts: MountEntry[] }) => FileSystem` | wasi-sh 的同步 `FileSystem` 适配器（busybox guest 侧视图） |
| `openBrowserSessionStorage` | `(directory: string, fs: BrowserFileSystem, context: Context, options?: JsonlStorageOptions) => Promise<Storage>` | pi-durable 会话存储的**浏览器侧装配**（批 2 B-1）：`JsonlStorage` 是 fs 注入式的（自己不开文件、不 import `node:fs`），`BrowserFileSystem` 是 `FileSystem` 契约的超集，直接喂进去，不需要 adapter；返回值就是 `createSession(storage)` 吃的 `Storage`。`JsonlStorageOptions`（**纯类型**）随该行透出（与下方类型行同一个惯例），目前只有 `fsync`；落盘时机仍要宿主自己调 `fs.flush()`（IDB 目录项写入有 500ms debounce） |
| `asDurableTool` | `<TParameters extends TSchema>(tool: AgentTool<TParameters, any>) => ToolRegistration<TParameters, any>` | pi-durable 编排层的工具接线（批 2 B-3）：把任一本仓工具（七工厂的产物）包成可装进 pi-durable `Registry` 的 `ToolRegistration`。一个通用函数覆盖七个工具——差别（grep 的 `fs`、bash 的 `operations`/`spill`）都在工厂的构造参数里，适配层只做 execute 的翻译（`onUpdate` 文本块 → `api.output`）与结果投影（`content`/`details`/`isError`/`usage`）。有意不搬：`label`（durable 侧无此位）、`structuredContent`（durable 结果面无此字段，七工厂也不产它）、`replay`/`executionMode`（两边**词表不同**，且是恢复策略不是翻译——归 B-2/B-4）；fs 在**构造期**捕获而非从 `api.env` 取（`ExecutionEnv` 取不出 `BrowserFileSystem`），详见 `src/tools/durable-tool.ts` 文件头 |
| `createReadTool` | `(cwd, o?: { operations?: ReadOperations; autoResizeImages?; resizeOptions?; photon?: ImagePhoton }) => AgentTool` | 读文本或图片（magic-byte 嗅探）；`operations` 缺省即抛（浏览器无默认 fs）；图片缩放的像素活要注入 `photon`（上游 photon-node 是 CJS + `fs.readFileSync(wasm)`，浏览器不可用，缝的名字与签名逐字取自上游的 `resizeImage` / `convertImageBytesToPng`）——不注入则只查 base64 字节上限 4.5MB（上游常量）并原样投递限内图片，超限按上游文案降级成文本；上游签名 + `createReadToolDefinition` / `readToolSystemPromptContribution` |
| `createWriteTool` | `(cwd, o?: { operations?: WriteOperations }) => AgentTool` | 覆盖写（`mkdir(dirname)` + writeFile）；成功文案 `Successfully wrote to <path>`（上游逐字）；`operations` 缺省即抛 |
| `createEditTool` | `(cwd, o?: { operations?: EditOperations }) => AgentTool` | `edits: [{ oldText, newText }]` 精确替换（上游 edit-diff 语义）；details 出 diff/patch/`firstChangedLine?`；`operations` 缺省即抛 |
| `createGrepTool` | `(cwd, o?: { operations?: GrepOperations; fs: BrowserFileSystem }) => AgentTool` | 正则/字面量搜索；`glob` 过滤 + 上下文行 + `file:line: text`；遍历走本仓 `fs`（**仅 grep**：上游把遍历外包给 rg，浏览器没有） |
| `createLsTool` | `(cwd, o?: { operations?: LsOperations }) => AgentTool` | 目录列表（`limit?`，默认 500）：条目名、目录带尾斜杠、不区分大小写排序；`operations` 缺省即抛 |
| `createFindTool` | `(cwd, o?: { operations?: FindOperations }) => AgentTool` | glob 找文件（`limit?`，默认 1000），结果相对**搜索根**；工具 `name` = `find`；`operations` 缺省即抛 |
| `createBashTool` | `(cwd, o?: { operations?: BashOperations; spill?; commandPrefix? }) => AgentTool` | `{ command, timeout? }`（无默认超时）经注入的 `BashOperations.exec` 跑 busybox；输出截断 + `spill` seam；wire-level `name` = `bash`（对齐上游） |
| `createReadToolDefinition` … `createBashToolDefinition` | 7 个定义件（各 `(cwd, o?) => ToolDefinition`） | 与工厂件同参数，但 execute 是**五参**（末位多 `ctx: ExtensionContext`）且读 `ctx.cwd` / `ctx.model` —— 「ctx.cwd 覆盖构造期 cwd」只有定义件能做到。宿主按定义件装配工具面（`wrapToolDefinition` 是内部件，从 `createExtensionRuntime` 之外拿不到） |
| `readToolSystemPromptContribution` … `bashToolSystemPromptContribution` | 7 个 `{ snippet: string; guidelines: string[] }` | 拼进宿主自己的 system prompt（定义件不带 prompt 文本）。文案逐字对齐上游，由 `test/tools-*.test.ts` 对着上游 `createXToolDefinition` 比对 |
| `OutputAccumulator` | `class`（`new OutputAccumulator(options)` / `append(bytes)` / `finish()` / `snapshot({ persistIfTruncated })` / `close()`） | shell 输出的累积与截断（替代 0.99.1 的 `ShellOutputView` 增量 diff 模型：上游已删）。配 `OutputAccumulatorSpill` 落盘（挂载表的 `/tmp`，见平台偏差 D2） |
| `relativizeFindResultPath` | `(resultPath: string, searchPath: string) => string` | 把 find 的结果路径相对化（find 内部也用它，导出供宿主拼自己的消息） |
| `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` / `formatSize` | `2000` / `50 * 1024` / `(bytes: number) => string` | 截断阈值与「已截断」提示里的尺寸文案（上游 `core/tools/truncate.js` 的同名导出，值一致）。配 `TruncationResult` / `MiddleTruncationResult` 读结果字段 |
| `loadSkills` | `(env: ExecutionEnv, o: { cwd; agentDir; skillPaths; includeDefaults }, ctx?) => Promise<{ skills; diagnostics }>` | 1.0.0 选项形状；首参的 `env` 是 fs 缝（同 grep 遍历 / find glob / bash operations：上游 1.0.0 的 loader 直接吃 node:fs，浏览器侧必须注入）——异步也是本仓偏差（上游同步）；`includeDefaults` 走 `<agentDir>/skills` + `<cwd>/.pi/skills` |
| `loadSkillsFromDir` | `(env: ExecutionEnv, o: { dir; source }, ctx?) => Promise<{ skills; diagnostics }>` | 扫描单个目录（`SKILL.md` 当根不下探；否则收根级 `.md` 再递归） |
| `formatSkillsForPrompt` | `(skills: Skill[], fileReadTool?: 'read' \| 'bash') => string` | 清单块（含 `<location>`，过滤 `disableModelInvocation`）；文案逐字对齐 1.0.0 |
| `createCompactionSummaryMessage` | `(summary: string, tokensBefore: number, timestamp: string) => CompactionSummaryMessage` | `compaction` 条目的消息投影（role `compactionSummary`）。**本包自持**（1.0.0 把 compaction 搬进 CLI 仓、不再从 agent-core 导出），实现体逐字对齐上游 1.0.0 并由 `test/compaction-selfhosted.test.ts` 对着上游 `dist/core/messages.js` 比对。⚠️ **破坏性**：`timestamp` 从 0.99.1 的 `string \| number` 收窄为 `string`（运行期等价，`new Date(n).getTime() === n`） |
| `DEFAULT_COMPACTION_SETTINGS` | `{ enabled; reserveTokens; keepRecentTokens }` | 上游默认值（`reserveTokens: 16384`——小 `contextWindow` 必须显式收窄，见下） |
| `createBrowserExecutionEnv`（续） | `hostCommands?: Record<string, HostCommandHandler>` | 宿主命令注册表（见「宿主命令」节） |
| `createHostCommandChannel` | `(sab: SharedArrayBuffer, o?: { timeoutMs? }) => { hostSide; guestSide }` | SAB/futex 双端协议（可脱离 exec 自建宿主/单测） |
| `createHostCommandSharedBuffer` | `(o?: { capacity? }) => SharedArrayBuffer` | 按容量分配通道内存（默认 8MB/方向） |
| `createHostCommandResponder` | `(store: { mounts }, handlers) => HostCommandResponder` | 宿主侧 glue：§3.3 对账 + 派发处理器 |
| `createGuestHostBuiltins` | `(guestFs, guestSide, names) => HostBuiltins` | guest 侧 glue：把宿主命令装成 wasi-sh builtins（worker 内） |
| `createExtensionRuntime` | `fn`（宿主用它造一份动作全是抛错 stub 的 runtime，再传给 `ExtensionRunner` 的构造器） | S6/P3 扩展面（见「扩展」节） |
| `ExtensionRunner` | `class`（`new ExtensionRunner(extensions, runtime, cwd)` / `bindCore(actions, contextActions)` / `load()` / `emit(...)` 与具名 `emitXxx` / `onError` / `hasHandlers` / `getAllRegisteredTools()` / `getToolDefinition(name)` / `createContext()` / `close()`） | S6/P3 宿主：持有 runtime 与注册表，装载扩展并由宿主在对应时机调 emit 入口（见「扩展」节） |
| `defineTool` | `<TParams, TDetails>(def: ToolDefinition<TParams, TDetails>) => ToolDefinition<TParams, TDetails>` | S6：上游同名辅助——顶住参数推断（赋给变量/进数组时 `params` 不被拓宽成 `unknown`） |
| `ExtensionAPI` / `ExtensionContext` / `ToolDefinition` / `Extension` / `ExtensionFactory` / `InlineExtension` / `ExtensionRuntime` / `ExtensionRuntimeState` / `ExtensionActions` / `ExtensionContextActions` / `ExtensionError` / `ExtensionErrorListener` / `RegisteredTool` / `SourceInfo` / `ToolInfo` / `EventBus` / `CompactOptions` / `ContextUsage` | 类型 | S6/P3 扩展面（见「扩展」节；`tool-definition-wrapper.ts` 的适配**函数**是内部件，只导出 `ToolContextFactory` 类型） |
| `ReadOperations` / `WriteOperations` / `EditOperations` / `EditDiffOperations` / `GrepOperations` / `FindOperations` / `LsOperations` / `BashOperations` + 各自的 `XToolOptions` / `XToolInput` / `XToolDetails`、`ImagePhoton` / `ImageResizeOptions` / `ProcessedImage` / `ResizedImage`、`OutputSnapshot` / `OutputAccumulatorOptions` / `OutputAccumulatorSpill`、`TruncationResult` / `MiddleTruncationResult` | 类型 | D5 注入缝与结果面（grep 的 `fs` 是本仓扩展字段：遍历留在库里，平台偏差见「平台偏差」节） |

七工具形状同上游：typebox `parameters` + `label` + `description` + `execute(toolCallId, input, signal?, onUpdate?)`，**失败 throw**（fs 类错误带 `FileErrorCode`，shell 带 `ExecutionErrorCode`）。

```ts
// ⚠️ 1.0.0 把 `Context` / `BACKGROUND_CONTEXT` 从 pi-agent-core 的 harness 移回 **chord 本体**，
//    agent-core 现在只剩 agent / agent-loop / proxy / stream-fn / types —— 从那里 import 会编译失败。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createBrowserExecutionEnv, createBrowserFileSystem, createReadTool, createBashTool } from '@lixianmin/pi-browser';

const env = createBrowserExecutionEnv();                        // '/'→IDB（持久）、'/tmp'→内存（临时）
await env.writeFile('/spice-sessions/s1/main.jsonl', line, BACKGROUND_CONTEXT);
const tmp = await env.createTempDir(undefined, BACKGROUND_CONTEXT);   // 固定落 /tmp 挂载

const fs = createBrowserFileSystem({ dbName: 'spice-sessions' });      // 会话存储用这个（含 flush 契约）
await fs.flush();                                                     // 每回合末调用，否则刷新页面丢会话

// 七工具都是 `(cwd, { operations? })`（D5：`operations` 缺省即抛，浏览器没有「本地文件系统」）。
// bash 另收 `spill?` / `commandPrefix?`；read 另收 `autoResizeImages?` / `resizeOptions?` / `photon?`。
// 形状 = 上游 `AgentTool[]`：交给 Agent / AgentContext。
const tools = [
  createReadTool('/projects/x', { operations: readOps }),
  createBashTool('/projects/x', { operations: bashOps, spill }),
];

### 文件读取语义（`readTextLines` / `openTextLineReader`）

- **`openTextLineReader(path, ctx)`**（pi 0.99.1 新增契约）：拉取式逐行读取，每行带 `terminated`（该行是否以换行结束）。上游 `readJsonlHeader` 用 `terminated === false` 识别「存储文件只写了一半」，所以 memory / IDB 两后端都如实回答这一位；`close()` 幂等、不抛，关闭后 `readLine` 返 `invalid`。
- **`readTextLines(path, options, ctx)`** 与上游 `NodeExecutionEnv` 同语义：**结尾换行不产生幽灵空行**（`"l1\nl2\n"` → `["l1","l2"]`；v0.5.0 及以前按 `split('\n')` 切会多出一行 `""`，0.99.1 升级时已按上游改了行为）、空文件 → `[]`；`maxLines <= 0` 直接返 `[]`（上游同款短路：连文件都不打开，缺失路径也返 `[]` 而不是 `not_found`）。
- 两者都由 `test/equivalence.node.test.ts` 的策展等价表与上游 `NodeExecutionEnv` 逐条比对（含末行截断、结尾换行、空文件、`maxLines: 0` 短路），`test/memory-backend.test.ts` / `test/idb-backend.test.ts` 另有一份同断言集。

## skills 与 compaction（S4）
- **skills**：`loadSkills(env, { cwd, agentDir, skillPaths, includeDefaults })`（或 `loadSkillsFromDir(env, { dir, source })`）加载，产物是 `Skill[]`（`{ name, description, filePath, baseDir, sourceInfo, disableModelInvocation }`——**没有 `content`**，调用 skill 时去 `filePath` 读文件）。清单渲染用 `formatSkillsForPrompt(skills, fileReadTool?)`。发现/校验规则（`SKILL.md`、frontmatter、忽略文件）由本库自持，形状与文案对齐 `pi-coding-agent@1.0.0`。
  - **破坏性变更（v0.6）**：`loadBrowserSkills` / `loadSkillsFromEnv` / `formatSkillInvocation` 已删。前两个由 `loadSkills` 的选项形状覆盖（自建 env 的便利路径改成 `createBrowserExecutionEnv()` + `loadSkills()` 两步显式写）；`formatSkillInvocation` 依赖 1.0.0 已删的 `skill.content`，上游没有同名物。
  - **破坏性变更（v0.6）**：`/skills` 不再是隐式加载的默认 root（1.0.0 没有「默认 roots」概念，`includeDefaults` 只覆盖 `<agentDir>/skills` 与 `<cwd>/.pi/skills`）。要 `/skills` 就在 `skillPaths` 里显式给。
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

const runtime = createExtensionRuntime();                       // 动作全是抛错 stub
const runner = new ExtensionRunner([{ name: 'demo-echo', factory: echo }], runtime, '/projects/x');
runner.bindCore(actions, contextActions);                       // 注入宿主能力后运行期成员才生效
await runner.load();                                            // 跑扩展工厂，收工具与事件订阅
runner.getAllRegisteredTools();                                 // 宿主自己注册（wrapToolDefinition → core 的 AgentTool）
await runner.emit({ type: 'agent_start' });                     // 事件由宿主在对应时机调 runner 的 emit 入口
```

### 接法：runtime + bindCore（换注入模型）

`ExtensionRunner` 不再在构造期抓 core 的 harness/lane。宿主造一份 `createExtensionRuntime()`（动作全是抛错 stub），
构造 runner，再 `bindCore(actions, contextActions)` 把宿主动作拷进共享 runtime——扩展面每个成员都不带 context，
指向同一份 runtime 就是"context 反演"的落点。`bindCore` 之前调用任何运行期成员都会响亮抛错（对齐 pi 的 loader 写法）。

事件不再挂 core 的 `hooks` / `events`：runner 提供 `emit(event)` 与具名 `emitToolCall` / `emitToolResult` /
`emitContext` / `emitMessageEnd` / `emitBeforeProviderRequest` / `emitBeforeProviderHeaders` /
`emitBeforeAgentStart` / `emitBoundary`，宿主在对的时机调用（控制流照抄上游）。
`pi.events` 那条总线**不走** `on(...)`：订阅面是 `pi.events.on`，生产面是 `runner.emitEventBus(type, event)`。

### 支持的 API 成员（14）

`on` / `registerTool` / `getActiveTools` / `getAllTools` / `setActiveTools` / `events` / `appendEntry` / `sendUserMessage` / `setSessionName` / `getSessionName` / `setLabel` / `setModel` / `getThinkingLevel` / `setThinkingLevel`

- **同步/异步错位已消解**：pi 的 `getSessionName` / `getThinkingLevel` / `getActiveTools` 是同步值，宿主在 `bindCore` 注入的就是同步动作（上游 `ExtensionActions` 同为同步），所以 API 直接读宿主动作，不再有缓存。
- **注册期锁**：扩展工厂里调用运行期成员会**响亮抛错**（对齐 pi 的 `assertActive()` 与 loader 的抛错 stub）；`close()` 后再次锁死。

### 不支持的 API 成员（18，保留原名）

- 无 slash 命令面 / 无 TUI：`registerCommand` / `getCommands` / `registerShortcut` / `registerFlag` / `getFlag` / `registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer`
- 配置面由 app 拥有，扩展只选择不注册：`registerProvider` / `unregisterProvider` / `registerVirtualModel` / `unregisterVirtualModel`（模型目录由 app 配置）
- 本仓无对应物，不发明形状：`getSettings`（pi 的 `Settings` 是 CLI 设置对象，浏览器宿主没有设置面）/ `registerMcpServer` / `unregisterMcpServer` / `getMcpServers`（MCP 连接管理器需要进程/网络侧，pi-agent-core / pi-ai 都无对应物）/ `exec`（pi 的 `ExecResult` 与 pi-agent-core 的 `Result` 形状映射未核实）/ `sendMessage`（pi 的 `display` 是 TUI 渲染函数，进不了 `JsonValue`）

### `ExtensionContext`：支持 5 / 不支持 13

- **支持**：`cwd` / `model` / `signal`（**本次调用**的信号）/ `abort()` / `compact()`
- **不支持**：TUI 与宿主进程概念（`ui` / `mode` / `hasUI` / `isProjectTrusted` / `shutdown`）；**同步/异步错位**（`isIdle` / `getContextUsage` / `getSystemPrompt` / `thinkingLevel`——上游是同步值，宿主侧要另建缓存，本仓无用例）；上游 CLI 专属复合对象（`sessionManager` / `modelRegistry` / `scopedModels`）；本仓无对应操作（`hasPendingMessages`）

### 事件：`on(event, handler)` 支持 25 / 不支持 16

**事件名是封闭集合，编译期就拦住。** `ExtensionAPI.on` 的签名是 `on<E extends keyof ExtensionEventMap>(event, handler)`——支持的事件名有补全，不支持/写错的名字**编不过**，不用等到运行期。载荷由宿主经 `emit` 交付，所以类型**逐字对齐 pi 1.0.0**（`src/extensions/events.ts`；`test/extensions-events-types.test.ts` 直接 import 上游 `.d.ts` 做双向 assignability 对照，转写漂了 tsc 当场红）。

```ts
pi.on('tool_call', (event) => {            // 联合按工具名分派：event.input 的类型跟着 toolName 变
  if (event.toolName === 'my-tool' && event.input.dangerous) return { block: true, reason: '越权' };
});
pi.on('ui_prompt_start', () => {});        // 编译错误：不支持的事件名
```

支持项按 pi 事件名逐条对应到 runner 的 emit 入口（`tool_call`→`emitToolCall`、`tool_result`→`emitToolResult`、`context`→`emitContext`、`message_end`→`emitMessageEnd`、`turn_end`→`emitBoundary`、`before_agent_start`→`emitBeforeAgentStart`、`before_provider_request`/`before_provider_headers`→各自的 `emitBeforeProvider*`，其余走通用 `emit({ type, … })`；`session_start`/`session_shutdown` 也由宿主发——`reason` 只有宿主知道）。分派控制流照抄上游：`tool_call` 的 `block` 短路、`session_before_*` 的 `cancel` 短路、`tool_result` 合并改写（换了 content 却没同时换 structuredContent 时丢弃后者）、`message_end` 拒绝换角色、`before_provider_headers` 原地改。handler 抛错不外泄，统一走 `runner.onError(listener)` 上报——**`tool_call` 除外**（`emitToolCall` 照抄上游：handler 抛错直接冒泡给宿主，因为阻止/放行是同一条同步决策链）。**每条支持事件都有「触发一次 → handler 被调用」的测试**（`test/extensions-events.test.ts`），不只测注册。

不支持（**编译期**拒，且注册期运行期也会抛、错误消息列支持清单）：`project_trust` / `resources_discover` / `session_info_changed` / `session_before_switch` / `session_before_fork` / `session_compact_failed` / `ui_prompt_start` / `ui_prompt_end` / `user_bash` / `input` / `agent_settled` / `mcp_servers_change` / `context_with_system` / `cache_warming_decision` / `provider_stream_event` / `agent_before_settle`。

后五条是上游 0.99 新增：`mcp_servers_change`（随 MCP 一组）、`cache_warming_decision`（CLI 常驻进程的缓存预热）、`provider_stream_event`（provider 归一化**之前**的原始事件）、`agent_before_settle`（CLI 会话管理器的 `BoundaryState`）在浏览器宿主上都没有对应面；`context_with_system` 的语义是「交付含 system 消息的完整 transcript，且 handler 拥有 prompt 与 **tool 声明**」——本仓 `context` 的落点 `transform_context` 改不了 tool 声明、payload 形状也不同，有对应物的那部分已被 `context` 覆盖，不另造「差不多」的形状。

### 工具重名

**后写覆盖先写**（对齐 pi 宿主的 Map 语义），差异只有一行 `console.warn`（黄线：本仓有「静默失效比报错更糟」的教训，但不新增自造接口名来承载告警）。S5 的「默认抛错 + `overrideBuiltins` 白名单」是自造行为，已删。

### 平台偏差

对着 pi-coding-agent@1.0.0 逐字对齐之后，仍然存在的差异都在这里列清（spec §3.4 的 D1–D7 逐条 +
迁移各批累积的）。**判断口径**：凡是上游依赖 Node 运行时（fs / Buffer / 临时目录 / wasm / 进程）
的地方，浏览器侧走同款「注入缝」或如实降级，不造「差不多」的替代物；凡是能对齐的，已经对齐。

**D1 `Buffer` → `Uint8Array`。** 上游 `ReadOperations.readFile` / `BashOperations.exec` 的 `onData` /
`OutputAccumulator.append` 都用 Node 全局 `Buffer`。`Buffer` 是 `Uint8Array` 的子类，只按字节用
时语义无损，不引入 `buffer` polyfill。

**D2 临时文件落挂载表。** 上游 `OutputAccumulator` 的 spill 走 `node:os.tmpdir()` +
`node:fs.createWriteStream`；本仓经挂载表里的 `/tmp` 写（`createBrowserExecutionEnv` 默认把它挂到内存）。
`OutputSnapshot.fullOutputPath` 因此是**浏览器虚拟路径**（如 `/tmp/pi-bash-xxx`），不是宿主真实路径。
没有 `/tmp` 挂载时它会落到 `/`（默认装配下即持久 IDB 会话库）——用 `OutputAccumulatorSpill` 可自定义。

**D3 `loadSkills` 异步。** 上游 1.0.0 是同步函数（Node fs）；浏览器后端（IDB / lightning-fs）的读
是 Promise，无法同步。名字与选项形状照抄，返回值是 `Promise<LoadSkillsResult>`。首参的 `env` 是 fs 缝。

**D4 `ExtensionRunner` 构造收窄为 `(extensions, runtime, cwd)`。** 上游多两个参数：`sessionManager`
实测写 1 次读 0 次，`modelRegistry` 只服务本仓已判「不支持」的 provider / 虚拟模型面。不收、不造 stub，
`getModelRegistry()` 随之不实现。`bindCore(actions, contextActions, providerActions?)` 的第三参传了就抛。

**D5 工具的 `operations` 缺省即抛错。** 上游 `options.operations?` 可省（缺省走本地 fs）；浏览器没有
「本地文件系统」。类型保持可选（保 1:1 形状），运行期缺省**响亮抛错**并给指引。同一族缝还有：
grep 的遍历与 glob 过滤、find / ls 的 glob / stat、bash 的 exec、edit 的 access、read 的图片 MIME 嗅探。

**D6 图片：嗅探做，缩放按注入缝给。** magic-byte 嗅探自持（无 node 依赖）；缩放需要
`@silvia-odwyer/photon-node`（Rust/WASM），而它的 CJS 入口在模块加载时
`require('fs').readFileSync(__dirname + '/photon_rs_bg.wasm')`、包内也没有 web 入口，所以像素活走
`ReadToolOptions.photon` 注入缝（成员名与签名逐字取自上游的 `resizeImage` / `convertImageBytesToPng`）。
**不注入时**只查 base64 字节上限 4.5MB（上游常量）并原样投递限内图片，超限按上游文案降级成文本说明 ——
刻意不抄上游「缺 photon 就把图全丢」的退化路径（那是宿主没装可选原生依赖的副作用）。**注入后**与上游一致，
含 2000×2000 的尺寸降采样。

**D8 compaction 是本包持有的一份上游实现副本。** `createCompactionSummaryMessage` /
`DEFAULT_COMPACTION_SETTINGS` / `CompactionSettings` 曾经是 pi-agent-core 的 re-export，而 1.0.0 把整套
compaction 搬进 CLI 仓、不再从 agent-core 导出。实现体逐字转写并由 `test/compaction-selfhosted.test.ts`
对着上游 `dist/core/messages.js` 逐条比对（`DEFAULT_COMPACTION_SETTINGS` 的三字段也一致）——
**代价是升级上游时要人工复核这份副本**。同类的还有 `src/extensions/events.ts`（25 条事件的载荷类型，
由 `test/extensions-events-types.test.ts` 对着上游 `.d.ts` 做双向 assignability 对照）。

**D7 浏览器没有的 shell 能力照旧声明不实现。** `spawnHook` / `shellPath` /
`exposeSessionEnvironment`（`PI_*`）在浏览器侧无对应物，不声明不生效的字段。相关平台事实：
busybox 只有一个进程，**无 fork**（后台任务 `&`、需 fork 的子 shell、进程替换会响亮失败）；
工具不给 exec 传 env（恒 `undefined`）；`timeout` 只在 worker 路径生效（inline 路径按 spec §4.5 豁免）；
工具**不回调 `onUpdate`**（上游有节流的增量快照）——长命令期间 UI 没有增量输出。

**其余迁移带来的偏差**（同一口径，逐条列）：

- **grep 的 glob 按 rg 规则复刻**（上游把 pattern 原样交给 `rg --glob`，本仓没有 rg 进程）：pattern 不含
  斜杠按 **basename** 匹配、含斜杠按**相对 cwd** 匹配、通配符吃点号（`--hidden`）。三条都用本机 rg 15.2.0
  实测钉死，有对照测试。偏差一处：pattern 带点斜杠前缀时 rg 返 0 条、本仓会匹配（朝「多给结果」偏）。
- **`.gitignore`**：grep / find 的 description 与 snippet 照抄上游的 `(respects .gitignore)`，但本仓遍历
  **不读** `.gitignore`（Spice 的虚拟工作区通常没有它）。
- **错误面**：工具的输入 / fs 错误抛带 `FileErrorCode` 的 `FileError`（spec §3.3），上游在部分路径上
  用 plain Error（如 edit-diff 的逻辑错误）——我们保留了错误码，代价是消息与上游不完全一致。
- **不做上游的模型侧兜底**：`constrainedSampling` / `prepareArguments` / renderers / 同文件写入串行化
  （`withFileMutationQueue`）一律不声明（声明了却不生效比不声明更糟）。
- **ls / find / grep 的参数面**：ls 删 `recursive` 改 `limit`、find 补 `limit`、grep `include` → `glob`；
  三者的输出路径改为上游语义（grep / find 相对搜索根、ls 只给条目名）。
- **edit 的 fuzzy 命中**：fuzzy 触发时**被命中整行**的未编辑字节会做 NFKC 归一 + trimEnd —— 这是上游
  1.0.0 的原行为（人类 2026-10-02 裁决接受），已用测试钉成有意行为。
- **事件**：`context` 只跑上游的第一相（第二相 `context_with_system` 标不支持：它的语义是「handler 拥有
  prompt 与 tool 声明」，本仓做不到）；`session_start` / `session_shutdown` 由**宿主**经 emit 发
  （`reason` 只有宿主知道）；`before_agent_start` 的 system prompt 渲染函数、`turn_end` 的
  `buildContext` 由宿主注入（浏览器侧没有 system prompt 构造器，宿主才是它的所有者）。
- **会话**：上游 1.0.0 的 `SessionManager` 是 `private constructor` + 直接 node:fs，喂不进本仓的
  `BrowserFileSystem`；本包也没有会话写手（会话写入是宿主的事）。所以格式对照落在 v3 JSONL + 上游的
  纯函数 `parseSessionEntries` / `buildSessionContext` / `prepareCompaction` / `shouldCompact` 上，
  本仓 fs 的落盘与追加另有往返测试。
- **`dirname` 的相对路径语义**：本仓的 `dirname('a') === '/'`（node:path 是 `'.'`）。write 建父目录时
  传的是已归一的绝对路径，不受影响。

### 仍不做

TS/jiti 加载、`~/.pi` 与 `.pi` 目录发现、项目信任门、`/reload` 热重载、终端 UI（见上文「不支持」清单的理由）。

## 开发

```sh
bun install && bunx vitest run
```

## 浏览器部署

Shell 能力（busybox exec）的 worker 路径依赖 `SharedArrayBuffer`：宿主页面需带 COOP/COEP 响应头（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`），并把 `@lixianmin/pi-browser/shell/worker` 打包为 worker 入口传给 `createBrowserExecutionEnv({ workerUrl })`。Node/测试环境走 inline 路径，无此要求（硬超时仅在 worker 路径生效）。
