// @vitest-environment node
// S4 spec §3.2 / §4.2-4.3：渲染与消费点接线。渲染器是上游 re-export（不自建，避免丢 `<location>`）；
// 这里只做冒烟：输出含 name/description/location、`disableModelInvocation` 被过滤、产物能进 `AgentHarnessResources`。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, type AgentHarnessResources } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv, formatSkillInvocation, formatSkillsForSystemPrompt, loadBrowserSkills } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const CTX = BACKGROUND_CONTEXT;

const SKILL = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n${body}\n`;

describe('skills 渲染（上游 re-export 冒烟）', () => {
	it('formatSkillsForSystemPrompt：含 name/description/location，过滤 disableModelInvocation', () => {
		const text = formatSkillsForSystemPrompt([
			{ name: 'pdf', description: '处理 PDF', content: '正文', filePath: '/skills/pdf/SKILL.md' },
			{ name: 'hidden', description: '不该出现', content: '正文', filePath: '/skills/hidden/SKILL.md', disableModelInvocation: true },
		]);

		expect(text).toContain('<name>pdf</name>');
		expect(text).toContain('<description>处理 PDF</description>');
		expect(text).toContain('<location>/skills/pdf/SKILL.md</location>');
		expect(text).not.toContain('hidden');
	});

	it('formatSkillInvocation：输出 skill 块（含 location 与正文）', () => {
		const text = formatSkillInvocation({ name: 'pdf', description: '处理 PDF', content: '第一步', filePath: '/skills/pdf/SKILL.md' }, '再补充一句');

		expect(text).toContain('<skill name="pdf" location="/skills/pdf/SKILL.md">');
		expect(text).toContain('第一步');
		expect(text).toContain('再补充一句');
	});
});

describe('加载产物进 AgentHarnessResources', () => {
	it('loadBrowserSkills 的 skills 可直接赋给 resources.skills，且渲染可用', async () => {
		const fs = createMemoryFileSystem();
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs }] });
		const written = await env.writeFile('/skills/pdf/SKILL.md', SKILL('name: pdf\ndescription: 处理 PDF', '# 步骤'), CTX);
		expect(written.ok).toBe(true);

		const { skills, diagnostics } = await loadBrowserSkills({ mounts: [{ prefix: '/', fs }] });
		const resources: AgentHarnessResources = { skills };   // 类型消费点：签名不匹配这里就编译不过（tsc 是闸门）

		expect(diagnostics).toEqual([]);
		expect(resources.skills?.map((s) => s.name)).toEqual(['pdf']);
		expect(formatSkillsForSystemPrompt(resources.skills ?? [])).toContain('<location>/skills/pdf/SKILL.md</location>');
	});
});
