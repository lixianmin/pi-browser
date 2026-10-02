// Task 7：公开面定稿（spec §3.4）。运行时导出 = S1 五导出 + 七工具工厂 + `createWasiFileSystem` + S4（skills/compaction）
// + S6（扩展宿主）+ 批2 B1 `openBrowserSessionStorage`（pi-durable 存储的浏览器侧装配）
// + 类型导出（BrowserFileSystem / MountEntry / Skill / ExtensionAPI …）在类型层，不进这两张运行时表。
// 新增导出必须同步本表与 README 的公开面表格。
//
// 批 2 B-3 变化：新增 `asDurableTool`（`AgentTool` → pi-durable `ToolRegistration` 的适配）。
//
// S6 变化：删 `defineExtension` / `composeToolset` / `toHarnessTool`（S5 自造名，`harness-tool.ts` 降为内部件），
// 新增 `ExtensionRunner`（宿主类，pi 同名）。扩展面换成 pi 的工厂式注册：`(pi: ExtensionAPI) => void`。
import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import * as api from '../src/index';
import type { Extension, ExtensionAPI } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { bashOps, editOps, findOps, grepOps, lsOps, readOps, writeOps } from './helpers/tool-operations';

const RUNTIME_EXPORTS = [
	'asDurableTool',
	'createBrowserExecutionEnv',
	'createBrowserFileSystem',
	'createCompactionSummaryMessage',
	'createBashTool',
	'createBashToolDefinition',
	'createEditTool',
	'createEditToolDefinition',
	'createExtensionRuntime',
	'createFindTool',
	'createFindToolDefinition',
	'createGrepTool',
	'createGrepToolDefinition',
	'createGuestHostBuiltins',
	'createHostCommandChannel',
	'createHostCommandResponder',
	'createHostCommandSharedBuffer',
	'createLsTool',
	'createLsToolDefinition',
	'createReadTool',
	'createReadToolDefinition',
	'createWasiFileSystem',
	'createWriteTool',
	'createWriteToolDefinition',
	'defineTool',
	'ExtensionRunner',
	'formatSize',
	'formatSkillsForPrompt',
	'loadSkills',
	'loadSkillsFromDir',
	'normalizePath',
	'openBrowserSessionStorage',
	'OutputAccumulator',
	'relativizeFindResultPath',
	'resetFsKernelRegistry',
];

/**
 * 运行时导出里的**非函数**：上游常量（`DEFAULT_*`）+ 七工具的 system prompt 贡献
 * （snippet / guidelines：宿主把它们拼进自己的 prompt —— 定义件不自带 prompt 文本）。
 */
const RUNTIME_CONSTANTS = [
	'DEFAULT_COMPACTION_SETTINGS',
	'DEFAULT_MAX_BYTES',
	'DEFAULT_MAX_LINES',
	'bashToolSystemPromptContribution',
	'editToolSystemPromptContribution',
	'findToolSystemPromptContribution',
	'grepToolSystemPromptContribution',
	'lsToolSystemPromptContribution',
	'readToolSystemPromptContribution',
	'writeToolSystemPromptContribution',
];

describe('公开面（src/index.ts）', () => {
	it('运行时导出清单精确匹配（多了少了都要显式改本表）', () => {
		expect(Object.keys(api).sort()).toEqual([...RUNTIME_EXPORTS, ...RUNTIME_CONSTANTS].sort());
	});

	it('贡献项形状：snippet + guidelines（宿主拼 prompt 用），与上游逐字由 tools 测试守', () => {
		for (const name of RUNTIME_CONSTANTS.filter((k) => k.endsWith('SystemPromptContribution'))) {
			const contribution = (api as Record<string, unknown>)[name] as { snippet: string; guidelines: string[] };
			expect(typeof contribution.snippet, name).toBe('string');
			expect(Array.isArray(contribution.guidelines), name).toBe(true);
		}
	});

	it('函数导出都是函数（ExtensionRunner / OutputAccumulator 是类，也是 function）', () => {
		for (const name of RUNTIME_EXPORTS) {
			expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
		}
	});

	it('常量导出形状与上游一致（compaction 默认设置三字段）', () => {
		expect(Object.keys(api.DEFAULT_COMPACTION_SETTINGS).sort()).toEqual(['enabled', 'keepRecentTokens', 'reserveTokens']);
		expect(typeof api.DEFAULT_COMPACTION_SETTINGS.enabled).toBe('boolean');
	});

	it('七工具工厂返回的 name 与上游对齐（全小写：read/write/edit/grep/ls/find/bash）', () => {
		const fs = createMemoryFileSystem();
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs }] });
		const names = [
			api.createReadTool('/', { operations: readOps(fs) }).name,
			api.createWriteTool('/', { operations: writeOps(fs) }).name,
			api.createEditTool('/', { operations: editOps(fs) }).name,
			api.createGrepTool('/', { fs }).name,
			api.createLsTool('/', { operations: lsOps(fs) }).name,
			api.createFindTool('/', { operations: findOps(fs) }).name,
			api.createBashTool('/', { operations: bashOps(env) }).name,
		];
		expect(names).toEqual(['read', 'write', 'edit', 'grep', 'ls', 'find', 'bash']);
	});

	it('S6 扩展面从包入口可用：宿主类是类，扩展是工厂（类型导出齐）', () => {
		expect(typeof api.ExtensionRunner).toBe('function');
		// 类型层 smoke：写一个扩展要能编过（`ToolDefinition` / `ExtensionAPI` / `Extension` 都在入口）
		const echo: Extension = (pi: ExtensionAPI) => {
			// `defineTool` 顶住参数推断：`input` 是 `{ text: string }` 而不是 `unknown`（上游同款辅助）
			const def = api.defineTool({
				name: 'Echo',
				label: 'Echo',
				description: '回显 text 参数',
				parameters: Type.Object({ text: Type.String() }),
				execute: async (_toolCallId, input) => ({ content: [{ type: 'text', text: input.text }], details: undefined }),
			});
			pi.registerTool(def);
		};
		expect(typeof echo).toBe('function');
	});
});
