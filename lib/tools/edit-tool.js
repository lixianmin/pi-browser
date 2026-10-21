// src/tools/edit-tool.ts —— Edit 工具（P2b Task 13）。
// 契约面 1:1 于 pi-coding-agent@1.0.2 dist/core/tools/edit.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / promptGuidelines / EditOperations / EditToolDetails / 两导出形状。
// 实现体自持：匹配/替换走 P2a 转写的 edit-diff（上游语义）；fs 由调用方注入（D5）。
// 不声明 `prepareArguments` / `withFileMutationQueue`（S6 §3.3：只留浏览器能兑现的字段；后者是实现体）。
import { Type } from 'typebox';
import { resolveToCwd } from './path-utils.js';
import { applyEditsToNormalizedContent, detectLineEnding, generateDiffString, generateUnifiedPatch, normalizeToLF, restoreLineEndings, } from './edit-diff.js';
import { splitBom } from './text.js';
import { throwIfAborted } from './fs-ops.js';
const replaceEditSchema = Type.Object({
    oldText: Type.String({
        description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
    }),
    newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
});
const editSchema = Type.Object({
    path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
    edits: Type.Array(replaceEditSchema, {
        description: 'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
    }),
});
export const editToolSystemPromptContribution = {
    snippet: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
    guidelines: [
        'Use edit for precise changes (edits[].oldText must match exactly)',
        'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
        'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
        'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.',
    ],
};
const editToolDescription = 'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.';
/** 浏览器没有默认文件系统（D5）：缺省即响亮报错。 */
function requireOperations(options) {
    const operations = options?.operations;
    if (operations === undefined) {
        throw new Error('edit tool: 浏览器没有默认文件系统，请在 options.operations 注入 EditOperations（D5）');
    }
    return operations;
}
/** 与上游 `Buffer.toString('utf-8')` 等价：`ignoreBOM: true` 表示不吞掉开头的 BOM（默认会吞）。 */
const _decoder = new TextDecoder('utf-8', { ignoreBOM: true });
async function executeEdit(cwd, input, signal, operations) {
    throwIfAborted(signal);
    // 上游 `validateEditInput` 的文案
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
    }
    const absolutePath = resolveToCwd(input.path, cwd);
    await operations.access(absolutePath);
    throwIfAborted(signal);
    const rawContent = _decoder.decode(await operations.readFile(absolutePath));
    throwIfAborted(signal);
    const { bom, text: content } = splitBom(rawContent);
    const originalEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLF(content);
    const editsAsDiff = input.edits.map((e) => ({ oldText: e.oldText, newText: e.newText }));
    const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, editsAsDiff, input.path);
    throwIfAborted(signal);
    const finalContent = bom + restoreLineEndings(newContent, originalEnding);
    await operations.writeFile(absolutePath, finalContent);
    throwIfAborted(signal);
    const diffResult = generateDiffString(baseContent, newContent);
    const patch = generateUnifiedPatch(input.path, baseContent, newContent);
    return {
        content: [{ type: 'text', text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
        details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
    };
}
export function createEditToolDefinition(cwd, options) {
    const operations = requireOperations(options);
    return {
        name: 'edit',
        label: 'edit',
        description: editToolDescription,
        promptSnippet: editToolSystemPromptContribution.snippet,
        promptGuidelines: [...editToolSystemPromptContribution.guidelines],
        parameters: editSchema,
        execute: (toolCallId, input, signal, _onUpdate, ctx) => executeEdit(ctx?.cwd || cwd, input, signal, operations),
    };
}
/** AgentTool 工厂：`AgentTool.execute` 只有 4 参（F6），cwd 恒为构造期值；需要 `ctx.cwd` 覆盖请用定义件。 */
export function createEditTool(cwd, options) {
    const operations = requireOperations(options);
    return {
        name: 'edit',
        label: 'edit',
        description: editToolDescription,
        parameters: editSchema,
        execute: (toolCallId, input, signal, _onUpdate) => executeEdit(cwd, input, signal, operations),
    };
}
