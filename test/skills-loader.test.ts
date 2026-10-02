// @vitest-environment node
// Task 5（skills 本地化）：名字/形状/文案对齐 pi-coding-agent@1.0.0 `dist/core/skills.d.ts`，
// 结构（async + env）照 pi-agent-core@0.99.1 `dist/harness/skills.js`（浏览器形状）。
// 双后端：内存（MemoryFileSystem）与 lightning-fs/IDB（`memory:false` + fake-indexeddb）。
import './helpers/idb';
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import type { ExecutionEnv } from '../src/env/types';
import { createBrowserExecutionEnv, createBrowserFileSystem } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from '../src/skills/loader';

const CTX = BACKGROUND_CONTEXT;

/** 每个测试拿一个新环境：IDB 库名互不干扰，内存后端实例也不共享（tag 由调用点保证唯一） */
function makeEnv(backend: 'memory' | 'indexeddb', tag: string): ExecutionEnv {
	return createBrowserExecutionEnv({
		mounts: [{
			prefix: '/',
			fs: backend === 'memory'
				? createMemoryFileSystem()
				: createBrowserFileSystem({ dbName: `skills-${tag}`, memory: false }),
		}],
	});
}

async function write(env: ExecutionEnv, path: string, content: string): Promise<void> {
	const written = await env.writeFile(path, content, CTX);
	if (!written.ok) throw new Error(`写入失败 ${path}: ${written.error.code}`);
}

const SKILL = (frontmatter: string, body = '# 正文\n步骤\n'): string => `---\n${frontmatter}\n---\n${body}`;

for (const backend of ['memory', 'indexeddb'] as const) {
	describe(`loadSkillsFromDir（${backend}）`, () => {
		it('合法 SKILL.md：1.0.0 字段集（无 content，有 baseDir/sourceInfo）', async () => {
			const env = makeEnv(backend, 'valid');
			await write(env, '/skills/pdf/SKILL.md', SKILL('name: pdf\ndescription: 处理 PDF'));

			const { skills, diagnostics } = await loadSkillsFromDir(env, { dir: '/skills', source: 'path' }, CTX);

			expect(diagnostics).toEqual([]);
			expect(skills).toEqual([{
				name: 'pdf',
				description: '处理 PDF',
				filePath: '/skills/pdf/SKILL.md',
				baseDir: '/skills/pdf',
				sourceInfo: { path: '/skills/pdf/SKILL.md', source: 'local', scope: 'temporary', origin: 'top-level', baseDir: '/skills/pdf' },
				disableModelInvocation: false,
			}]);
			// `content` 必须不在字段集里（1.0.0 删了它；调用 skill 时去 filePath 读文件）
			expect(Object.keys(skills[0]!).sort()).toEqual(['baseDir', 'description', 'disableModelInvocation', 'filePath', 'name', 'sourceInfo']);
		});

		it('SKILL.md 缺 description → warning（无 code 字段），不产出 skill', async () => {
			const env = makeEnv(backend, 'nodesc');
			await write(env, '/skills/pdf/SKILL.md', SKILL('name: pdf'));

			const { skills, diagnostics } = await loadSkillsFromDir(env, { dir: '/skills', source: 'path' }, CTX);

			expect(skills).toEqual([]);
			expect(diagnostics).toEqual([{ type: 'warning', message: 'description is required', path: '/skills/pdf/SKILL.md' }]);
		});

		it('畸形 frontmatter → warning（1.0.0 无 code 字段）', async () => {
			const env = makeEnv(backend, 'malformed');
			await write(env, '/skills/pdf/SKILL.md', '---\ndescription: [未闭合\n---\n正文\n');

			const { skills, diagnostics } = await loadSkillsFromDir(env, { dir: '/skills', source: 'path' }, CTX);

			expect(skills).toEqual([]);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({ type: 'warning', path: '/skills/pdf/SKILL.md' });
		});

		it('根级 .md 缺 description → 静默忽略且无 diagnostic；带的则加载，name 取父目录名', async () => {
			const env = makeEnv(backend, 'root-md');
			await write(env, '/skills/note.md', '随手记，没有 frontmatter\n');
			await write(env, '/skills/tip.md', SKILL('description: 独立条目'));

			const { skills, diagnostics } = await loadSkillsFromDir(env, { dir: '/skills', source: 'path' }, CTX);

			expect(diagnostics).toEqual([]);
			// 根级 .md 没写 name 时取父目录名（上游规则：name 缺省 = skill 文件所在目录名 = '/skills'）
			expect(skills.map((s) => s.name)).toEqual(['skills']);
			expect(skills[0]!.description).toBe('独立条目');
			expect(skills[0]!.baseDir).toBe('/skills');
		});

		it('目录含 SKILL.md 即当 skill 根，不再下探同目录子目录', async () => {
			const env = makeEnv(backend, 'no-recurse');
			await write(env, '/skills/pdf/SKILL.md', SKILL('name: pdf\ndescription: 处理 PDF'));
			await write(env, '/skills/pdf/nested/SKILL.md', SKILL('name: nested\ndescription: 不该被读到'));

			const { skills } = await loadSkillsFromDir(env, { dir: '/skills', source: 'path' }, CTX);

			expect(skills.map((s) => s.name)).toEqual(['pdf']);
		});

		it('不存在的目录静默返回空（不报错、无 diagnostic）', async () => {
			const env = makeEnv(backend, 'missing-dir');

			expect(await loadSkillsFromDir(env, { dir: '/nope', source: 'path' }, CTX)).toEqual({ skills: [], diagnostics: [] });
		});
	});
}

describe('loadSkills：选项形状（1.0.0）', () => {
	it('includeDefaults：<agentDir>/skills（user）+ <cwd>/.pi/skills（project），sourceInfo.scope 分开', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }] });
		await write(env, '/.pi/agent/skills/a/SKILL.md', SKILL('name: a\ndescription: 全局'));
		await write(env, '/work/.pi/skills/b/SKILL.md', SKILL('name: b\ndescription: 项目'));

		const { skills, diagnostics } = await loadSkills(
			env, { cwd: '/work', agentDir: '/.pi/agent', skillPaths: [], includeDefaults: true }, CTX,
		);

		expect(diagnostics).toEqual([]);
		expect(skills.map((s) => [s.name, s.sourceInfo.scope, s.sourceInfo.source])).toEqual([['a', 'user', 'local'], ['b', 'project', 'local']]);
	});

	it('skillPaths 收目录与单个 .md；相对路径按 cwd 解析；不存在的路径给出 warning', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }] });
		await write(env, '/work/vendor/x/SKILL.md', SKILL('name: x\ndescription: 目录里的'));
		await write(env, '/work/single.md', SKILL('name: single\ndescription: 单文件'));
		await write(env, '/work/notes.txt', '随手记，不是 skill\n');

		const { skills, diagnostics } = await loadSkills(env, {
			cwd: '/work',
			agentDir: '/.pi/agent',
			includeDefaults: false,
			skillPaths: ['vendor', 'single.md', '/work/not-there', '/work/notes.txt'],
		}, CTX);

		expect(skills.map((s) => s.name)).toEqual(['x', 'single']);
		expect(diagnostics).toEqual([
			{ type: 'warning', message: 'skill path does not exist', path: '/work/not-there' },
			{ type: 'warning', message: 'skill path is not a markdown file', path: '/work/notes.txt' },
		]);
	});

	it('同名冲突：先到者胜，出一条 collision 诊断（不顶掉 winner）', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }] });
		await write(env, '/one/pdf/SKILL.md', SKILL('name: pdf\ndescription: 第一个'));
		await write(env, '/two/pdf/SKILL.md', SKILL('name: pdf\ndescription: 第二个'));

		const { skills, diagnostics } = await loadSkills(env, {
			cwd: '/', agentDir: '/.pi/agent', includeDefaults: false, skillPaths: ['/one', '/two'],
		}, CTX);

		expect(skills.map((s) => s.description)).toEqual(['第一个']);
		expect(diagnostics).toEqual([{
			type: 'collision',
			message: 'name "pdf" collision',
			path: '/two/pdf/SKILL.md',
			collision: { resourceType: 'skill', name: 'pdf', winnerPath: '/one/pdf/SKILL.md', loserPath: '/two/pdf/SKILL.md' },
		}]);
	});
});

describe('formatSkillsForPrompt（1.0.0 逐字文案）', () => {
	const skill = (over: Partial<Skill> = {}): Skill => ({
		name: 'pdf',
		description: '处理 PDF',
		filePath: '/skills/pdf/SKILL.md',
		baseDir: '/skills/pdf',
		sourceInfo: { path: '/skills/pdf/SKILL.md', source: 'local', scope: 'temporary', origin: 'top-level', baseDir: '/skills/pdf' },
		disableModelInvocation: false,
		...over,
	});

	it('空列表（或全被 disableModelInvocation 过滤）返回空串', () => {
		expect(formatSkillsForPrompt([])).toBe('');
		expect(formatSkillsForPrompt([skill({ disableModelInvocation: true })])).toBe('');
	});

	it('逐字等于上游文案（注意开头是两个换行）', () => {
		expect(formatSkillsForPrompt([skill()])).toBe([
			'',
			'',
			'The following skills provide specialized instructions for specific tasks.',
			"Use the read tool to load a skill's file when the task matches its description.",
			'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
			'',
			'<available_skills>',
			'  <skill>',
			'    <name>pdf</name>',
			'    <description>处理 PDF</description>',
			'    <location>/skills/pdf/SKILL.md</location>',
			'  </skill>',
			'</available_skills>',
		].join('\n'));
	});

	it("fileReadTool: 'bash' 换一行文案；XML 五实体转义", () => {
		const text = formatSkillsForPrompt([skill({ name: 'a&b<c', description: 'x"y\'z' })], 'bash');

		expect(text).toContain('Use bash to load a skill');
		expect(text).toContain('<name>a&amp;b&lt;c</name>');
		expect(text).toContain('<description>x&quot;y&apos;z</description>');
	});

	it('disableModelInvocation 的条目不出现在清单里', () => {
		expect(formatSkillsForPrompt([skill(), skill({ name: 'hidden', disableModelInvocation: true })])).not.toContain('hidden');
	});
});
