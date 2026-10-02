// @vitest-environment node
// Task 5：skills 的渲染与消费点接线。渲染器现在是本包自持（文案逐字对齐 pi-coding-agent@1.0.0）。
// `formatSkillInvocation` 已删（1.0.0 无同名物）；`AgentHarnessResources` 的接线在 P3 随构造模型重建。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { createBrowserExecutionEnv, formatSkillsForPrompt, loadSkills } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const CTX = BACKGROUND_CONTEXT;

const SKILL = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n${body}\n`;
const skill = (over: Record<string, unknown> = {}) => ({
	name: 'pdf',
	description: '处理 PDF',
	filePath: '/skills/pdf/SKILL.md',
	baseDir: '/skills/pdf',
	sourceInfo: { path: '/skills/pdf/SKILL.md', source: 'local', scope: 'temporary' as const, origin: 'top-level' as const, baseDir: '/skills/pdf' },
	disableModelInvocation: false,
	...over,
});

describe('skills 渲染（本包自持）', () => {
	it('formatSkillsForPrompt：含 name/description/location，过滤 disableModelInvocation', () => {
		const text = formatSkillsForPrompt([
			skill(),
			skill({ name: 'hidden', description: '不该出现', disableModelInvocation: true }),
		]);

		expect(text).toContain('<name>pdf</name>');
		expect(text).toContain('<description>处理 PDF</description>');
		expect(text).toContain('<location>/skills/pdf/SKILL.md</location>');
		expect(text).not.toContain('hidden');
	});
});

describe('加载产物直接喂渲染', () => {
	it('loadSkills 的 skills 渲染出 `<location>`', async () => {
		const fs = createMemoryFileSystem();
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs }] });
		const written = await env.writeFile('/skills/pdf/SKILL.md', SKILL('name: pdf\ndescription: 处理 PDF', '# 步骤'), CTX);
		expect(written.ok).toBe(true);

		const { skills, diagnostics } = await loadSkills(
			env, { cwd: '/', agentDir: '/.pi/agent', skillPaths: ['/skills'], includeDefaults: false }, CTX,
		);

		expect(diagnostics).toEqual([]);
		expect(skills.map((s) => s.name)).toEqual(['pdf']);
		expect(formatSkillsForPrompt(skills)).toContain('<location>/skills/pdf/SKILL.md</location>');
	});
});
