// src/index.ts —— 公开面：S1 五导出 + S2 增量（七工具工厂 + `createWasiFileSystem` + `MountEntry`，spec §3.4）。
// 浏览器产物面禁 deep import——消费者一律从这个入口拿，也只在 `.` / `./harness/session` 两个上游入口取东西
// （deep import 各自散落会随上游内部重构漂）。
// `createMemoryFileSystem` 是内部件不导出（现无外部消费者，AGENTS §2）；memory/idb 两个后端的契约
// 由测试直接 import src/env/* 覆盖（spec §3 测试 1）。
export { createBrowserFileSystem, type BrowserFileSystemOptions } from './env/backend-idb';
export type { BrowserFileSystem, MountEntry } from './env/types';
export { normalizePath } from './env/path';
export { createBrowserExecutionEnv } from './env/execution-env';
export { createWasiFileSystem } from './shell/wasi-fs';
export { createReadTool } from './tools/read-tool';
export { createWriteTool } from './tools/write-tool';
export { createEditTool } from './tools/edit-tool';
export { createGrepTool } from './tools/grep-tool';
export { createLsTool } from './tools/ls-tool';
export { createGlobTool } from './tools/glob-tool';
export { createShellTool } from './tools/shell-tool';
// S4 skills（spec §3.4）：加载是本地薄封装，渲染直接 re-export 上游（不自建渲染器：会丢 `<location>`）
export { formatSkillInvocation, formatSkillsForSystemPrompt, type Skill, type SkillDiagnostic, type SkillDiagnosticCode } from '@earendil-works/pi-agent-core';
export { loadBrowserSkills, loadSkillsFromEnv, type SkillsLoadResult } from './skills/loader';
// S4 compaction（spec §3.4）：只透出设置与消息构造（`compact`/`prepareCompaction` 不 re-export——
// 直接调那两条会引入 pi-ai 运行时依赖；harness 自带自动压缩）
export { createCompactionSummaryMessage, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from '@earendil-works/pi-agent-core';
// S2.1 宿主命令 seam（通用件）：注册表类型 + 双端通道（可脱离 exec 自建宿主/单测）——seam 不认具体命令语义
export {
	createGuestHostBuiltins, createHostCommandChannel, createHostCommandResponder, createHostCommandSharedBuffer,
	type HostCommandChannel, type HostCommandExchangeRequest, type HostCommandExchangeResult,
	type HostCommandGuestSide, type HostCommandHandler, type HostCommandHostSide, type HostCommandRequest,
	type HostCommandRegistry, type HostCommandResponder, type HostCommandResult,
} from './shell/host-commands';
// S5 extensions（spec §3.1）：只做「工具注册」这一子集——扩展是宿主自己的对象（不经 jiti、不做 fs 发现），
// 校验/归一 → 与内置合成一份工具集；产物是上游 `AgentTool[]`（交给 `Agent`/`AgentContext`），
// 要进 `AgentHarness` 得过一层 `toHarnessTool`（两侧 execute 签名不同）。
// 不支持的 pi 扩展面（事件/commands/providers/UI/热重载…）见 README「扩展（仅工具注册子集）」节。
export { defineExtension, type ExtensionSpec, type ExtensionToolSpec } from './extensions/define';
export { composeToolset, type ComposeToolsetOptions, type ComposedToolset } from './extensions/compose';
export { toHarnessTool } from './extensions/harness-tool';
