import { type Context } from '../env/context.js';
import type { ExecutionEnv } from '../env/types.js';
import type { SourceInfo } from '../extensions/api.js';
export interface SkillFrontmatter {
    name?: string;
    description?: string;
    'disable-model-invocation'?: boolean;
    [key: string]: unknown;
}
export interface ResourceCollision {
    resourceType: 'extension' | 'skill' | 'prompt' | 'theme';
    name: string;
    winnerPath: string;
    loserPath: string;
    winnerSource?: string;
    loserSource?: string;
}
export interface ResourceDiagnostic {
    type: 'warning' | 'error' | 'collision';
    message: string;
    path?: string;
    collision?: ResourceCollision;
}
export interface Skill {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    sourceInfo: SourceInfo;
    disableModelInvocation: boolean;
}
export interface LoadSkillsResult {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
}
export interface LoadSkillsFromDirOptions {
    /** 要扫描的目录（虚拟绝对路径） */
    dir: string;
    /** 来源标识，原样进 `Skill.sourceInfo.source`（`'user'` / `'project'` / `'path'` 有特殊 scope 语义） */
    source: string;
}
export interface LoadSkillsOptions {
    /** 项目工作目录（相对 skillPaths 按它解析；`includeDefaults` 时取 `<cwd>/.pi/skills`） */
    cwd: string;
    /** agent 配置目录（`includeDefaults` 时取 `<agentDir>/skills`） */
    agentDir: string;
    /** 显式 skill 路径（目录或单个 `.md`） */
    skillPaths: string[];
    /** 是否加载默认目录（上游布局：`<agentDir>/skills` + `<cwd>/.pi/skills`） */
    includeDefaults: boolean;
}
/**
 * 从一个目录加载 skills。
 *
 * 发现规则（上游 1.0.2）：
 * - 目录里有 `SKILL.md` ⇒ 当 skill 根，不再下探
 * - 否则收根目录直属的 `.md`
 * - 再递归子目录找 `SKILL.md`
 */
export declare function loadSkillsFromDir(env: ExecutionEnv, options: LoadSkillsFromDirOptions, context?: Context): Promise<LoadSkillsResult>;
/** 从配置的各个位置加载 skills（上游 `LoadSkillsOptions` 的浏览器版：env 作首参，返回 Promise） */
export declare function loadSkills(env: ExecutionEnv, options: LoadSkillsOptions, context?: Context): Promise<LoadSkillsResult>;
/** 把 skills 渲染成 system prompt 的 XML 清单块（文案逐字取自上游 1.0.2） */
export declare function formatSkillsForPrompt(skills: Skill[], fileReadTool?: 'read' | 'bash'): string;
