// src/skills/loader.ts —— skills 加载（S4 spec §3.1）：上游 `loadSkills` 的薄封装，只定默认 roots。
//
// 本文件**不含**发现/校验规则，也不含渲染器：`SKILL.md` 遍历、frontmatter 解析、忽略文件、
// diagnostics 编码全归上游 `loadSkills`（两份真相 = 两份行为漂移，S4 spec §6 明确非目标）。
// diagnostics 原样透出（不吞、不重排）——调用方要能看见「哪个声明文件坏了」。
import { BACKGROUND_CONTEXT, loadSkills, type ExecutionEnv, type Skill, type SkillDiagnostic } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv, type BrowserExecutionEnvOptions } from '../env/execution-env';

/** 默认 skills 根：`/skills`（仓库内约定）+ `/.pi/skills`（上游 agent 布局约定） */
export const DEFAULT_SKILL_ROOTS = ['/skills', '/.pi/skills'];

export interface SkillsLoadResult {
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}

/** 在已有 env 上加载（调用方自己管 env 生命周期；IDB 已打开时不必再建一个） */
export function loadSkillsFromEnv(env: ExecutionEnv, roots: string[] = DEFAULT_SKILL_ROOTS): Promise<SkillsLoadResult> {
	return loadSkills(env, roots, BACKGROUND_CONTEXT);
}

/**
 * 自建一个浏览器 ExecutionEnv 再加载。
 * 需要 `.agents/skills` 之类的额外布局时，调用方直接在自己的 `roots` 里给路径——规则由上游处理，
 * 这里不加「布局开关」（S4 spec §3.1）。
 */
export async function loadBrowserSkills(options: BrowserExecutionEnvOptions & { roots?: string[] } = {}): Promise<SkillsLoadResult> {
	const env = createBrowserExecutionEnv({ dbName: options.dbName, mounts: options.mounts });
	return await loadSkillsFromEnv(env, options.roots);
}
