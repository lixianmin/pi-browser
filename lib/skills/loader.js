// src/skills/loader.ts —— skills 的发现 / 校验 / 渲染（浏览器自持）。
//
// 名字、形状、校验规则与 prompt 文案逐字对齐 `pi-coding-agent@1.0.2 dist/core/skills.d.ts` /
// `dist/core/skills.js`；结构（async + 经 `ExecutionEnv` 读盘）照 `pi-agent-core@0.99.1
// dist/harness/skills.js`——上游 1.0.2 的实现在 Node 侧同步读 fs，浏览器后端的读是 Promise（spec D3）。
import ignore from 'ignore';
import { parse } from 'yaml';
import { BACKGROUND_CONTEXT } from '../env/context.js';
import { normalizePath } from '../env/path.js';
/** Agent Skills spec 的名字长度上限（上游同名常量） */
const MAX_NAME_LENGTH = 64;
/** Agent Skills spec 的描述长度上限（上游同名常量） */
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.fdignore'];
/** 项目级配置目录名（上游 `pi-coding-agent dist/config.js` 的 `CONFIG_DIR_NAME`） */
const CONFIG_DIR_NAME = '.pi';
/**
 * 从一个目录加载 skills。
 *
 * 发现规则（上游 1.0.2）：
 * - 目录里有 `SKILL.md` ⇒ 当 skill 根，不再下探
 * - 否则收根目录直属的 `.md`
 * - 再递归子目录找 `SKILL.md`
 */
export function loadSkillsFromDir(env, options, context = BACKGROUND_CONTEXT) {
    return loadSkillsFromDirInternal(env, options.dir, options.source, true, ignore(), options.dir, context);
}
/** 从配置的各个位置加载 skills（上游 `LoadSkillsOptions` 的浏览器版：env 作首参，返回 Promise） */
export async function loadSkills(env, options, context = BACKGROUND_CONTEXT) {
    const resolvedCwd = normalizePath(options.cwd);
    const resolvedAgentDir = normalizePath(options.agentDir);
    const userSkillsDir = joinVirtual(resolvedAgentDir, 'skills');
    const projectSkillsDir = joinVirtual(resolvedCwd, CONFIG_DIR_NAME, 'skills');
    const skillMap = new Map();
    const realPathSet = new Set();
    const allDiagnostics = [];
    const collisionDiagnostics = [];
    async function addSkills(result) {
        allDiagnostics.push(...result.diagnostics);
        for (const skill of result.skills) {
            // 解符号链接后的真实路径用来去重（同一文件经两条路径加载时静默跳过）
            const canonical = await env.canonicalPath(skill.filePath, context);
            const realPath = canonical.ok ? canonical.value : skill.filePath;
            if (realPathSet.has(realPath))
                continue;
            const existing = skillMap.get(skill.name);
            if (existing) {
                collisionDiagnostics.push({
                    type: 'collision',
                    message: `name "${skill.name}" collision`,
                    path: skill.filePath,
                    collision: {
                        resourceType: 'skill',
                        name: skill.name,
                        winnerPath: existing.filePath,
                        loserPath: skill.filePath,
                    },
                });
            }
            else {
                skillMap.set(skill.name, skill);
                realPathSet.add(realPath);
            }
        }
    }
    if (options.includeDefaults) {
        await addSkills(await loadSkillsFromDirInternal(env, userSkillsDir, 'user', true, ignore(), userSkillsDir, context));
        await addSkills(await loadSkillsFromDirInternal(env, projectSkillsDir, 'project', true, ignore(), projectSkillsDir, context));
    }
    const isUnderPath = (target, root) => target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
    const getSource = (resolvedPath) => {
        // 上游语义：只有显式 skillPaths 落在默认目录下时才标 user/project，其余一律 'path'
        if (!options.includeDefaults) {
            if (isUnderPath(resolvedPath, userSkillsDir))
                return 'user';
            if (isUnderPath(resolvedPath, projectSkillsDir))
                return 'project';
        }
        return 'path';
    };
    for (const rawPath of options.skillPaths) {
        const resolvedPath = await resolveSkillPath(env, rawPath, resolvedCwd, context);
        const exists = await env.exists(resolvedPath, context);
        if (!exists.ok) {
            // `exists` 的 err **不是**「不存在」：例如挂载表对没有挂载点覆盖的路径返 not_supported。
            // 用真实原因告警，否则用户会照「路径不存在」去查一个其实是挂载配置的问题。
            if (exists.error.code !== 'not_found') {
                allDiagnostics.push({ type: 'warning', message: exists.error.message, path: resolvedPath });
            }
            continue;
        }
        if (!exists.value) {
            allDiagnostics.push({ type: 'warning', message: 'skill path does not exist', path: resolvedPath });
            continue;
        }
        const info = await env.fileInfo(resolvedPath, context);
        if (!info.ok) {
            allDiagnostics.push({ type: 'warning', message: info.error.message, path: resolvedPath });
            continue;
        }
        const kind = await resolveKind(env, info.value, allDiagnostics, context);
        const source = getSource(resolvedPath);
        if (kind === 'directory') {
            await addSkills(await loadSkillsFromDirInternal(env, resolvedPath, source, true, ignore(), resolvedPath, context));
            continue;
        }
        if (kind === 'file' && resolvedPath.endsWith('.md')) {
            const result = await loadSkillFromFile(env, resolvedPath, source, context);
            if (result.skill)
                await addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
            else
                allDiagnostics.push(...result.diagnostics);
            continue;
        }
        allDiagnostics.push({ type: 'warning', message: 'skill path is not a markdown file', path: resolvedPath });
    }
    return { skills: [...skillMap.values()], diagnostics: [...allDiagnostics, ...collisionDiagnostics] };
}
/** 把 skills 渲染成 system prompt 的 XML 清单块（文案逐字取自上游 1.0.2） */
export function formatSkillsForPrompt(skills, fileReadTool = 'read') {
    const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
    if (visibleSkills.length === 0)
        return '';
    const lines = [
        '\n\nThe following skills provide specialized instructions for specific tasks.',
        fileReadTool === 'read'
            ? "Use the read tool to load a skill's file when the task matches its description."
            : "Use bash to load a skill's file when the task matches its description.",
        'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
        '',
        '<available_skills>',
    ];
    for (const skill of visibleSkills) {
        lines.push('  <skill>');
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push('  </skill>');
    }
    lines.push('</available_skills>');
    return lines.join('\n');
}
async function loadSkillsFromDirInternal(env, dir, source, includeRootFiles, ignoreMatcher, rootDir, context) {
    const skills = [];
    const diagnostics = [];
    const dirInfo = await env.fileInfo(dir, context);
    if (!dirInfo.ok) {
        if (dirInfo.error.code !== 'not_found') {
            diagnostics.push({ type: 'warning', message: dirInfo.error.message, path: dir });
        }
        return { skills, diagnostics };
    }
    if ((await resolveKind(env, dirInfo.value, diagnostics, context)) !== 'directory')
        return { skills, diagnostics };
    await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics, context);
    const entries = await env.listDir(dir, context);
    if (!entries.ok) {
        diagnostics.push({ type: 'warning', message: entries.error.message, path: dir });
        return { skills, diagnostics };
    }
    // 有 SKILL.md 就是 skill 根：只收它，不再下探
    for (const entry of entries.value) {
        if (entry.name !== 'SKILL.md')
            continue;
        if ((await resolveKind(env, entry, diagnostics, context)) !== 'file')
            continue;
        if (ignoreMatcher.ignores(relativeEnvPath(rootDir, entry.path)))
            continue;
        const result = await loadSkillFromFile(env, entry.path, source, context);
        if (result.skill)
            skills.push(result.skill);
        diagnostics.push(...result.diagnostics);
        return { skills, diagnostics };
    }
    // 顺序固定（`listDir` 的顺序不保证）：加载结果的稳定顺序是公开面的一部分
    for (const entry of [...entries.value].sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules')
            continue;
        const kind = await resolveKind(env, entry, diagnostics, context);
        if (!kind)
            continue;
        const relPath = relativeEnvPath(rootDir, entry.path);
        if (ignoreMatcher.ignores(kind === 'directory' ? `${relPath}/` : relPath))
            continue;
        if (kind === 'directory') {
            const sub = await loadSkillsFromDirInternal(env, entry.path, source, false, ignoreMatcher, rootDir, context);
            skills.push(...sub.skills);
            diagnostics.push(...sub.diagnostics);
            continue;
        }
        if (!includeRootFiles || !entry.name.endsWith('.md'))
            continue;
        const result = await loadSkillFromFile(env, entry.path, source, context);
        if (result.skill)
            skills.push(result.skill);
        diagnostics.push(...result.diagnostics);
    }
    return { skills, diagnostics };
}
async function addIgnoreRules(env, matcher, dir, rootDir, diagnostics, context) {
    const relativeDir = relativeEnvPath(rootDir, dir);
    const prefix = relativeDir ? `${relativeDir}/` : '';
    for (const filename of IGNORE_FILE_NAMES) {
        const ignorePath = await env.joinPath([dir, filename], context);
        if (!ignorePath.ok) {
            diagnostics.push({ type: 'warning', message: ignorePath.error.message, path: dir });
            continue;
        }
        const info = await env.fileInfo(ignorePath.value, context);
        if (!info.ok) {
            if (info.error.code !== 'not_found') {
                diagnostics.push({ type: 'warning', message: info.error.message, path: ignorePath.value });
            }
            continue;
        }
        if (info.value.kind !== 'file')
            continue;
        const content = await env.readTextFile(ignorePath.value, context);
        if (!content.ok) {
            diagnostics.push({ type: 'warning', message: content.error.message, path: ignorePath.value });
            continue;
        }
        const patterns = content.value
            .split(/\r?\n/)
            .map((line) => prefixIgnorePattern(line, prefix))
            .filter((line) => Boolean(line));
        if (patterns.length > 0)
            matcher.add(patterns);
    }
}
/** 忽略规则是相对 root 的；子目录里的 ignore 文件要补上「相对 root 的前缀」才等价于 gitignore 语义 */
function prefixIgnorePattern(line, prefix) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('#') && !trimmed.startsWith('\\#'))
        return null;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith('!')) {
        negated = true;
        pattern = pattern.slice(1);
    }
    else if (pattern.startsWith('\\!')) {
        pattern = pattern.slice(1);
    }
    if (pattern.startsWith('/'))
        pattern = pattern.slice(1);
    const prefixed = prefix ? `${prefix}${pattern}` : pattern;
    return negated ? `!${prefixed}` : prefixed;
}
async function loadSkillFromFile(env, filePath, source, context) {
    const diagnostics = [];
    const isDeclaredSkill = basenameEnvPath(filePath) === 'SKILL.md';
    const rawContent = await env.readTextFile(filePath, context);
    if (!rawContent.ok) {
        diagnostics.push({ type: 'warning', message: rawContent.error.message, path: filePath });
        return { skill: null, diagnostics };
    }
    const parsed = parseFrontmatter(rawContent.value);
    if (!parsed.ok) {
        // 根级 `.md` 的 frontmatter 坏了不吵（它可能只是普通笔记）；`SKILL.md` 坏了要报
        if (isDeclaredSkill)
            diagnostics.push({ type: 'warning', message: parsed.error.message, path: filePath });
        return { skill: null, diagnostics };
    }
    const { frontmatter } = parsed.value;
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : undefined;
    const hasDescription = typeof description === 'string' && description.trim() !== '';
    // 根级 `.md` 没有 description 就不算 skill（静默跳过）
    if (!isDeclaredSkill && !hasDescription)
        return { skill: null, diagnostics };
    const skillDir = dirnameEnvPath(filePath);
    for (const error of validateDescription(description)) {
        diagnostics.push({ type: 'warning', message: error, path: filePath });
    }
    const frontmatterName = typeof frontmatter.name === 'string' ? frontmatter.name : undefined;
    const name = frontmatterName || basenameEnvPath(skillDir);
    for (const error of validateName(name)) {
        diagnostics.push({ type: 'warning', message: error, path: filePath });
    }
    // 名字/描述不合规只告警，仍加载——唯独 description 缺失时放弃
    if (!hasDescription)
        return { skill: null, diagnostics };
    return {
        skill: {
            name,
            description: description,
            filePath,
            baseDir: skillDir,
            sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
            disableModelInvocation: frontmatter['disable-model-invocation'] === true,
        },
        diagnostics,
    };
}
/**
 * 去掉 UTF-8 BOM（上游 `pi-coding-agent dist/utils/text.js:stripBom` 的同义物）。
 * 必须在解析前归一：`startsWith('---')` 会把带 BOM 的 frontmatter 当成「没有 frontmatter」，
 * 于是一个合法 `SKILL.md` 静默变成一个没有 description 的文件——Windows 编辑器存出来的就是这形状。
 */
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
function validateName(name) {
    const errors = [];
    if (name.length > MAX_NAME_LENGTH)
        errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
    if (!/^[a-z0-9-]+$/.test(name))
        errors.push('name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)');
    if (name.startsWith('-') || name.endsWith('-'))
        errors.push('name must not start or end with a hyphen');
    if (name.includes('--'))
        errors.push('name must not contain consecutive hyphens');
    return errors;
}
function validateDescription(description) {
    if (!description || description.trim() === '')
        return ['description is required'];
    if (description.length > MAX_DESCRIPTION_LENGTH) {
        return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
    }
    return [];
}
function parseFrontmatter(content) {
    try {
        const normalized = stripBom(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!normalized.startsWith('---'))
            return { ok: true, value: { frontmatter: {} } };
        const endIndex = normalized.indexOf('\n---', 3);
        if (endIndex === -1)
            return { ok: true, value: { frontmatter: {} } };
        const parsed = parse(normalized.slice(4, endIndex));
        return { ok: true, value: { frontmatter: (parsed ?? {}) } };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error('failed to parse skill file') };
    }
}
/** `FileInfo.kind` 只区分 file/directory 两种有效值；符号链接要解到真身再看 */
async function resolveKind(env, info, diagnostics, context) {
    if (info.kind === 'file' || info.kind === 'directory')
        return info.kind;
    const canonical = await env.canonicalPath(info.path, context);
    if (!canonical.ok) {
        if (canonical.error.code !== 'not_found') {
            diagnostics.push({ type: 'warning', message: canonical.error.message, path: info.path });
        }
        return undefined;
    }
    const target = await env.fileInfo(canonical.value, context);
    if (!target.ok) {
        if (target.error.code !== 'not_found') {
            diagnostics.push({ type: 'warning', message: target.error.message, path: info.path });
        }
        return undefined;
    }
    return target.value.kind === 'file' || target.value.kind === 'directory' ? target.value.kind : undefined;
}
/** 浏览器无 package metadata：按上游 `createSkillSourceInfo` 合成 `SourceInfo`（origin 一律 top-level） */
function createSkillSourceInfo(filePath, baseDir, source) {
    const scope = source === 'user' ? 'user' : source === 'project' ? 'project' : 'temporary';
    return {
        path: filePath,
        source: source === 'user' || source === 'project' || source === 'path' ? 'local' : source,
        scope,
        origin: 'top-level',
        baseDir,
    };
}
function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
async function resolveSkillPath(env, rawPath, cwd, context) {
    const trimmed = rawPath.trim();
    if (trimmed.startsWith('/'))
        return normalizePath(trimmed);
    const joined = await env.joinPath([cwd, trimmed], context);
    return joined.ok ? joined.value : normalizePath(`${cwd}/${trimmed}`);
}
function joinVirtual(...parts) {
    return normalizePath(parts.filter(Boolean).join('/'));
}
function basenameEnvPath(path) {
    const normalized = path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index === -1 ? normalized : normalized.slice(index + 1);
}
function dirnameEnvPath(path) {
    const normalized = path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
}
/** root 相对路径（上游 `relativeEnvPath`）：隔离 ignore 匹配域与诊断路径的写法 */
function relativeEnvPath(root, path) {
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalizedPath === normalizedRoot)
        return '';
    return normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath.replace(/^\/+/, '');
}
