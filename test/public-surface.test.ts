// Task 7：公开面定稿（spec §3.4）。运行时导出 = S1 五导出 + 七工具工厂 + `createWasiFileSystem` + S4（skills/compaction）；
// 类型导出（BrowserFileSystem / MountEntry / Skill / CompactionSettings …）在类型层，不进这两张运行时表。
// 新增导出必须同步本表与 README 的公开面表格。
import { describe, it, expect } from 'vitest';
import * as api from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const RUNTIME_EXPORTS = [
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
	'formatSkillInvocation',
	'formatSkillsForSystemPrompt',
	'loadBrowserSkills',
	'loadSkillsFromEnv',
	'normalizePath',
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
});
