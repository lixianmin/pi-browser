// @vitest-environment node
// S4 spec §3.1 / §4.1：`loadBrowserSkills`/`loadSkillsFromEnv` 是上游 `loadSkills` 的薄封装——
// 本文件只钉「默认 roots + diagnostics 原样透出」这件事；发现/校验规则本身归上游，不复刻。
// 双后端：内存（MemoryFileSystem）与 lightning-fs/IDB（`memory:false` + fake-indexeddb）。
import './helpers/idb';
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv, createBrowserFileSystem, resetFsKernelRegistry } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { DEFAULT_SKILL_ROOTS, loadBrowserSkills, loadSkillsFromEnv } from '../src/skills/loader';

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
	describe(`loadSkillsFromEnv（${backend}）`, () => {
		it('合法 SKILL.md：content 是剥离 frontmatter 的正文，无 diagnostic', async () => {
			const env = makeEnv(backend, 'valid');
			await write(env, '/skills/pdf/SKILL.md', SKILL('name: pdf\ndescription: 处理 PDF'));

			const { skills, diagnostics } = await loadSkillsFromEnv(env);

			expect(diagnostics).toEqual([]);
			expect(skills).toEqual([{
				name: 'pdf',
				description: '处理 PDF',
				content: '# 正文\n步骤',
				filePath: '/skills/pdf/SKILL.md',
				disableModelInvocation: false,
			}]);
		});

		it('SKILL.md 缺 description → invalid_metadata（不产出 skill）', async () => {
			const env = makeEnv(backend, 'nodesc');
			await write(env, '/skills/pdf/SKILL.md', SKILL('name: pdf'));

			const { skills, diagnostics } = await loadSkillsFromEnv(env);

			expect(skills).toEqual([]);
			expect(diagnostics.map((d) => d.code)).toEqual(['invalid_metadata']);
			expect(diagnostics[0]?.path).toBe('/skills/pdf/SKILL.md');
		});

		it('SKILL.md 畸形 frontmatter → parse_failed', async () => {
			const env = makeEnv(backend, 'malformed');
			await write(env, '/skills/pdf/SKILL.md', '---\ndescription: [未闭合\n---\n正文\n');

			const { skills, diagnostics } = await loadSkillsFromEnv(env);

			expect(skills).toEqual([]);
			expect(diagnostics.map((d) => d.code)).toEqual(['parse_failed']);
		});

		it('根级 .md 缺 description → 静默忽略且无 diagnostic；带的则加载', async () => {
			const env = makeEnv(backend, 'root-md');
			await write(env, '/skills/note.md', '随手记，没有 frontmatter\n');
			await write(env, '/skills/tip.md', SKILL('description: 独立条目', '看这里\n'));

			const { skills, diagnostics } = await loadSkillsFromEnv(env);

			expect(diagnostics).toEqual([]);
			// 根级 .md 没写 name 时取 root 目录名（上游规则：name 缺省 = 父目录名 = '/skills' → 'skills'）
			expect(skills.map((s) => s.name)).toEqual(['skills']);
			expect(skills[0]?.content).toBe('看这里');
		});

		it('默认 roots 覆盖 /skills 与 /.pi/skills，多 root 合并', async () => {
			const env = makeEnv(backend, 'roots');
			await write(env, '/skills/a/SKILL.md', SKILL('name: a\ndescription: 第一个'));
			await write(env, '/.pi/skills/b/SKILL.md', SKILL('name: b\ndescription: 第二个'));

			expect(DEFAULT_SKILL_ROOTS).toEqual(['/skills', '/.pi/skills']);
			const { skills, diagnostics } = await loadSkillsFromEnv(env);

			expect(diagnostics).toEqual([]);
			expect(skills.map((s) => s.name)).toEqual(['a', 'b']);
		});

		it('显式 roots 覆盖默认值；不存在的 root 静默跳过', async () => {
			const env = makeEnv(backend, 'custom-roots');
			await write(env, '/skills/a/SKILL.md', SKILL('name: a\ndescription: 第一个'));
			await write(env, '/other/c/SKILL.md', SKILL('name: c\ndescription: 第三个'));

			const { skills, diagnostics } = await loadSkillsFromEnv(env, ['/other', '/missing']);

			expect(diagnostics).toEqual([]);
			expect(skills.map((s) => s.name)).toEqual(['c']);
		});
	});
}

describe('loadBrowserSkills：自建 ExecutionEnv', () => {
	it('memory mounts：默认 roots 下读到注入后端里的 skill', async () => {
		const fs = createMemoryFileSystem();
		const mounts = [{ prefix: '/', fs }];
		await write(createBrowserExecutionEnv({ mounts }), '/.pi/skills/pdf/SKILL.md', SKILL('name: pdf\ndescription: 处理 PDF'));

		const { skills, diagnostics } = await loadBrowserSkills({ mounts });

		expect(diagnostics).toEqual([]);
		expect(skills.map((s) => s.name)).toEqual(['pdf']);
	});

	it('IDB 后端：flush 后的新实例能读到（dbName 路径的持久面）', async () => {
		const fs = createBrowserFileSystem({ dbName: 'skills-shared', memory: false });
		await write(createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs }] }), '/skills/pdf/SKILL.md', SKILL('name: pdf\ndescription: 处理 PDF'));
		await fs.flush();
		await fs.cleanup(CTX);

		// 清内核注册表：reopened 必须是真·新实例从 IDB 重载，否则共享 CacheFS 恒绿、不再测落盘本身
		resetFsKernelRegistry();
		const reopened = createBrowserFileSystem({ dbName: 'skills-shared', memory: false });
		const { skills } = await loadBrowserSkills({ mounts: [{ prefix: '/', fs: reopened }] });

		expect(skills.map((s) => s.description)).toEqual(['处理 PDF']);
	});
});
