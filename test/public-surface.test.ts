// Task 7：公开面定稿（spec §3.4）。运行时导出 = S1 五导出 + 七工具工厂 + `createWasiFileSystem` + S4（skills/compaction）；
// 类型导出（BrowserFileSystem / MountEntry / Skill / CompactionSettings …）在类型层，不进这两张运行时表。
// 新增导出必须同步本表与 README 的公开面表格。
import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import * as api from '../src/index';
import type { ComposedToolset, ComposeToolsetOptions, ExtensionSpec } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const RUNTIME_EXPORTS = [
	'composeToolset',
	'createBrowserExecutionEnv',
	'createBrowserFileSystem',
	'createCompactionSummaryMessage',
	'createEditTool',
	'createGlobTool',
	'createGrepTool',
	'createGuestHostBuiltins',
	'createHostCommandChannel',
	'createHostCommandResponder',
	'createHostCommandSharedBuffer',
	'createLsTool',
	'createReadTool',
	'createShellTool',
	'createWasiFileSystem',
	'createWriteTool',
	'defineExtension',
	'formatSkillInvocation',
	'formatSkillsForSystemPrompt',
	'loadBrowserSkills',
	'loadSkillsFromEnv',
	'normalizePath',
	'toHarnessTool',
];

/** 运行时导出里的非函数（re-export 的上游常量） */
const RUNTIME_CONSTANTS = ['DEFAULT_COMPACTION_SETTINGS'];

describe('公开面（src/index.ts）', () => {
	it('运行时导出清单精确匹配（多了少了都要显式改本表）', () => {
		expect(Object.keys(api).sort()).toEqual([...RUNTIME_EXPORTS, ...RUNTIME_CONSTANTS].sort());
	});

	it('函数导出都是函数', () => {
		for (const name of RUNTIME_EXPORTS) {
			expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
		}
	});

	it('常量导出形状与上游一致（compaction 默认设置三字段）', () => {
		expect(Object.keys(api.DEFAULT_COMPACTION_SETTINGS).sort()).toEqual(['enabled', 'keepRecentTokens', 'reserveTokens']);
		expect(typeof api.DEFAULT_COMPACTION_SETTINGS.enabled).toBe('boolean');
	});

	it('七工具工厂返回的 name 与工具面一致', () => {
		const fs = createMemoryFileSystem();
		const names = [
			api.createReadTool({ fs }).name,
			api.createWriteTool({ fs }).name,
			api.createEditTool({ fs }).name,
			api.createGrepTool({ fs }).name,
			api.createLsTool({ fs }).name,
			api.createGlobTool({ fs }).name,
		];
		expect(names).toEqual(['Read', 'Write', 'Edit', 'Grep', 'Ls', 'Glob']);
	});

	it('S5 扩展面从包入口可用（合成产物形状 = AgentTool[]，类型导出齐）', () => {
		const spec: ExtensionSpec = api.defineExtension({
			name: 'ext-a',
			tools: [{
				name: 'Echo',
				description: '回显',
				parameters: Type.Object({ text: Type.String() }),
				execute: async (_toolCallId, input) => ({ content: [{ type: 'text', text: input.text }], details: undefined }),
			}],
		});
		const options: ComposeToolsetOptions = { extensions: [spec] };
		const toolset: ComposedToolset = api.composeToolset(options);

		expect(toolset.tools.map((t) => t.name)).toEqual(['Echo']);
		expect(toolset.providerOf.Echo).toBe('ext-a');
		// S6 T3：适配器改签名（多一个 ExtensionContext 构造器）；该文件的 S5 面清理见 T5
		expect(api.toHarnessTool(toolset.tools[0], () => ({
			cwd: '/w', model: undefined, signal: undefined, abort: () => {}, compact: () => {},
		})).name).toBe('Echo');
	});
});
