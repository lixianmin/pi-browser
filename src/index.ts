// src/index.ts —— 公开面：S1 五导出 + S2 增量（七工具工厂 + `createWasiFileSystem` + `MountEntry`，spec §3.4）。
// 浏览器产物面禁 deep import——消费者一律从这个入口拿，也只在 `.` / `./harness/session` 两个上游入口取东西
// （deep import 各自散落会随上游内部重构漂）。
// `createMemoryFileSystem` 是内部件不导出（现无外部消费者，AGENTS §2）；memory/idb 两个后端的契约
// 由测试直接 import src/env/* 覆盖（spec §3 测试 1）。
//
// P6 收口（spec §4 第 2 / 第 5 条）：把 P2/P3/P4 各批**推迟**的导出一次性补齐——
//   · 七工具的 `createXToolDefinition` + `xToolSystemPromptContribution`（宿主要按定义件装配工具面，
//     并把 snippet/guidelines 拼进 system prompt；工厂件只认构造期 cwd，spec §3.1 的 ctx.cwd 覆盖靠定义件）；
//   · `XOperations` 类型族（含 grep 的本仓扩展 `fs` 字段、D5 注入缝）；
//   · 图片处理的 `ImagePhoton` / `ImageResizeOptions`（read 的 `options.photon` 缝的形状）；
//   · shell 输出侧的 `OutputAccumulator` / `OutputSnapshot` / `OutputAccumulatorSpill`（spec §4 第 5 条：
//     删掉 `ShellOutputView` 等自造面后，替代物要能从入口拿到）；
//   · `relativizeFindResultPath`（find 的路径相对化，宿主要用它把结果路径拼进自己的消息）。
// 仍然不导出的（AGENTS §2 无消费者 / §3 内部件）：`createMemoryFileSystem`、`wrapToolDefinition`
// （适配**函数**是内部件，只导出它的 `ToolContextFactory` 类型）、`processImage` 的实现体经
// `ImagePhoton` 类型间接可用。
export { createBrowserFileSystem, resetFsKernelRegistry, type BrowserFileSystemOptions } from './env/backend-idb';
export type { BrowserFileSystem, MountEntry } from './env/types';
export { normalizePath } from './env/path';
export { createBrowserExecutionEnv } from './env/execution-env';
export { createWasiFileSystem } from './shell/wasi-fs';
// pi-durable 会话存储的浏览器侧装配（批 2 B-1）：fs 注入式存储，`BrowserFileSystem` 直接喂进去，无需 adapter
export { openBrowserSessionStorage } from './session/storage';
export type { JsonlStorageOptions } from '@earendil-works/pi-durable/storage/jsonl';
// pi-durable 编排层的会话/Harness 装配（批 2 B-2）：模型/注册表/存储/环境逐个由调用方给，本仓不硬编 provider
export { openBrowserHarness, asDurableTools, type OpenBrowserHarnessOptions } from './session/harness';
// pi-durable 编排层的 compaction 接缝（批 2 B-4）：压缩执行体在内建 `CompactionTask` 里，本仓不实现压缩；
// 公开面只透出 durable 的四字段 `CompactionPolicy` 缺省值（镜像上游 `DEFAULT_COMPACTION_POLICY`，见该文件头），
// **不是**下面 `./compaction/compaction` 那份三字段的 `DEFAULT_COMPACTION_SETTINGS`（后者是 CLI 侧会话文件
// 那一半的适配件，两者不是同一契约，详见该文件头）。缺省值由 durable 自己在 `Harness.open` 时补齐，
// 装配层不 merge 这一份。
export { DEFAULT_BROWSER_COMPACTION_POLICY } from './session/compaction';
export { createReadTool, createReadToolDefinition, readToolSystemPromptContribution } from './tools/read-tool';
export { createWriteTool, createWriteToolDefinition, writeToolSystemPromptContribution } from './tools/write-tool';
export { createEditTool, createEditToolDefinition, editToolSystemPromptContribution } from './tools/edit-tool';
export { createGrepTool, createGrepToolDefinition, grepToolSystemPromptContribution } from './tools/grep-tool';
export { createLsTool, createLsToolDefinition, lsToolSystemPromptContribution } from './tools/ls-tool';
export { createFindTool, createFindToolDefinition, findToolSystemPromptContribution, relativizeFindResultPath } from './tools/find-tool';
export { createBashTool, createBashToolDefinition, bashToolSystemPromptContribution } from './tools/bash-tool';
// pi-durable 编排层的工具接线（批 2 B-3）：`AgentTool` → `ToolRegistration` 的适配，一个通用函数覆盖七工具
export { asDurableTool } from './tools/durable-tool';
// D5 注入缝与各工具的 options/details/入参类型（逐模块导，不另开 barrel 文件）
export type { BashOperations, BashToolDetails, BashToolInput, BashToolOptions } from './tools/bash-tool';
export type { EditOperations, EditToolDetails, EditToolInput, EditToolOptions } from './tools/edit-tool';
export type { FindOperations, FindToolDetails, FindToolInput, FindToolOptions } from './tools/find-tool';
export type { GrepOperations, GrepToolDetails, GrepToolInput, GrepToolOptions } from './tools/grep-tool';
export type { LsOperations, LsToolDetails, LsToolInput, LsToolOptions } from './tools/ls-tool';
export type { ReadOperations, ReadToolDetails, ReadToolInput, ReadToolOptions } from './tools/read-tool';
export type { WriteOperations, WriteToolInput, WriteToolOptions } from './tools/write-tool';
export type { EditDiffOperations } from './tools/edit-diff';
// 截断与图片处理的结果面（宿主拼「已截断 / 已降级」提示时要读这些字段）
export type { MiddleTruncationResult, TruncationResult } from './tools/truncate';
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from './tools/truncate';
export type { ImagePhoton, ImageResizeOptions, ProcessedImage, ResizedImage } from './tools/image-process';
// shell 输出（spec §4 第 5 条：替代 `ShellOutputView` 的那半面）
export { OutputAccumulator, type OutputAccumulatorOptions, type OutputAccumulatorSpill, type OutputSnapshot } from './shell/output-accumulator';
// S4 skills（spec §3.4 / P4）：发现、校验、渲染全在本包（名字/形状/文案对齐 1.0.0，异步是本仓偏差 D3）。
// `loadBrowserSkills` / `loadSkillsFromEnv`（自造名，R3）与 `formatSkillInvocation`（依赖 1.0.0 已删的
// `skill.content`）都已移除。
export {
	formatSkillsForPrompt, loadSkills, loadSkillsFromDir,
	type LoadSkillsFromDirOptions, type LoadSkillsOptions, type LoadSkillsResult,
	type ResourceCollision, type ResourceDiagnostic, type Skill, type SkillFrontmatter,
} from './skills/loader';
// S4 compaction（spec §3.4）：只透出设置与消息构造（`compact`/`prepareCompaction` 不 re-export——
// 直接调那两条会引入 pi-ai 运行时依赖；harness 自带自动压缩）
export { createCompactionSummaryMessage, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings, type CompactionSummaryMessage } from './compaction/compaction';
// S2.1 宿主命令 seam（通用件）：注册表类型 + 双端通道（可脱离 exec 自建宿主/单测）——seam 不认具体命令语义
export {
	createGuestHostBuiltins, createHostCommandChannel, createHostCommandResponder, createHostCommandSharedBuffer,
	type HostCommandChannel, type HostCommandExchangeRequest, type HostCommandExchangeResult,
	type HostCommandGuestSide, type HostCommandHandler, type HostCommandHostSide, type HostCommandRequest,
	type HostCommandRegistry, type HostCommandResponder, type HostCommandResult,
} from './shell/host-commands';
// S6 extensions（spec 2026-09-19 §3.1）：「宿主 + 扩展工厂」两件。扩展是宿主自己的对象
// （不经 jiti、不做 fs 发现），形如 `(pi: ExtensionAPI) => void | Promise<void>`。
// **对外面只出现 pi 的同名成员**（名单与支持/不支持裁决见 `src/extensions/contract.ts` 与 README「扩展」节）；
// 浏览器做不到的成员保留原名、明确列不支持，不造「差不多」的名字。
// `extensions/tool-definition-wrapper.ts`（`ToolDefinition` → `AgentTool` 适配）是内部件，不经包入口导出。
// P3 起宿主的接法是「造 runtime → new ExtensionRunner(extensions, runtime, cwd) → runner.bindCore(actions, contextActions)」，
// 事件由宿主在对应时机调 runner 的 `emit` / 具名 `emitXxx`（不再挂 core 的 hooks/events）。
export { ExtensionRunner } from './extensions/runner';
export { createExtensionRuntime } from './extensions/runtime';
export { defineTool } from './extensions/tool';
export type { ExtensionActions, ExtensionContextActions, ExtensionRuntime, ExtensionRuntimeState } from './extensions/runtime';
export type { BoundaryDispatchResult, ExtensionError, ExtensionErrorListener, RegisteredTool } from './extensions/runner';
export type {
	EventBus, Extension, ExtensionAPI, ExtensionFactory, InlineExtension, SourceInfo, ToolInfo,
} from './extensions/api';
export type { CompactOptions, ContextUsage, ExtensionContext } from './extensions/context';
export type { ToolContextFactory } from './extensions/tool-definition-wrapper';
export type { ToolDefinition } from './extensions/tool';
