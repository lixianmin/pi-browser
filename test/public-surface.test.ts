// Task 7：公开面定稿（spec §3.4）。运行时导出清单 = S1 五导出 + 七工具工厂 + `createWasiFileSystem`；
// 类型导出（BrowserFileSystem / BrowserFileSystemOptions / MountEntry）在类型层，不进这张运行时表。
// 新增导出必须同步本表与 README 的公开面表格。
import { describe, it, expect } from 'vitest';
import * as api from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const RUNTIME_EXPORTS = [
	'createBrowserExecutionEnv',
	'createBrowserFileSystem',
	'createEditTool',
	'createGlobTool',
	'createGrepTool',
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

describe('公开面（src/index.ts）', () => {
	it('运行时导出清单精确匹配（多了少了都要显式改本表）', () => {
		expect(Object.keys(api).sort()).toEqual([...RUNTIME_EXPORTS].sort());
	});

	it('全部导出是函数（本版公开面没有导出常量/类）', () => {
		for (const name of RUNTIME_EXPORTS) {
			expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
		}
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
