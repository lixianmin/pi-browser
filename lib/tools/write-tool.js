// src/tools/write-tool.ts —— Write 工具（P2b Task 12）。
// 契约面 1:1 于 pi-coding-agent@1.0.2 dist/core/tools/write.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / promptGuidelines / WriteOperations / 两导出形状（details 恒为 undefined）。
// 实现体自持：fs 由调用方注入（D5）；不移植上游的 `withFileMutationQueue`（实现体、非契约面）。
// 成功文案与上游逐字：`Successfully wrote to <path>`（本仓旧版的 `(N bytes)` 后缀已删）。
// 注意：即使写到挂载根，`operations.mkdir(dirname(abs))` 也会被调一次（参数可能是 `/`）——
// 注入的 `mkdir` 必须幂等且递归（接口注释已声明递归）。
import { Type } from 'typebox';
import { dirname } from '../env/path.js';
import { resolveToCwd } from './path-utils.js';
import { throwIfAborted } from './fs-ops.js';
const writeSchema = Type.Object({
    path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
    content: Type.String({ description: 'Content to write to the file' }),
});
export const writeToolSystemPromptContribution = {
    snippet: 'Create or overwrite files',
    guidelines: ['Use write only for new files or complete rewrites.'],
};
const writeToolDescription = "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";
/** 浏览器没有默认文件系统（D5）：缺省即响亮报错。 */
function requireOperations(options) {
    const operations = options?.operations;
    if (operations === undefined) {
        throw new Error('write tool: 浏览器没有默认文件系统，请在 options.operations 注入 WriteOperations（D5）');
    }
    return operations;
}
async function executeWrite(cwd, input, signal, operations) {
    throwIfAborted(signal);
    const absolutePath = resolveToCwd(input.path, cwd);
    const dir = dirname(absolutePath);
    await operations.mkdir(dir);
    throwIfAborted(signal);
    await operations.writeFile(absolutePath, input.content);
    throwIfAborted(signal);
    return { content: [{ type: 'text', text: `Successfully wrote to ${input.path}` }], details: undefined };
}
export function createWriteToolDefinition(cwd, options) {
    const operations = requireOperations(options);
    return {
        name: 'write',
        label: 'write',
        description: writeToolDescription,
        promptSnippet: writeToolSystemPromptContribution.snippet,
        promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
        parameters: writeSchema,
        execute: (toolCallId, input, signal, _onUpdate, ctx) => executeWrite(ctx?.cwd || cwd, input, signal, operations),
    };
}
/** AgentTool 工厂：`AgentTool.execute` 只有 4 参（F6），cwd 恒为构造期值；需要 `ctx.cwd` 覆盖请用定义件。 */
export function createWriteTool(cwd, options) {
    const operations = requireOperations(options);
    return {
        name: 'write',
        label: 'write',
        description: writeToolDescription,
        parameters: writeSchema,
        execute: (toolCallId, input, signal, _onUpdate) => executeWrite(cwd, input, signal, operations),
    };
}
