// src/tools/read-tool.ts —— Read 工具（P2b Task 11）。
// 契约面 1:1 于 pi-coding-agent@1.0.2 dist/core/tools/read.{js,d.ts}：schema 字段描述 / description /
// promptSnippet / promptGuidelines / ReadToolDetails / ReadOperations / 两导出形状。
// 实现体自持（spec §3.1）：片段构造与截断文案按上游逐字转写，fs 访问由调用方注入（D5），
// 输入/fs 错误仍是带 FileErrorCode 的 FileError（spec §3.3）。
// D6 / R1：图片做 magic-byte 嗅探；**缩放本体（photon）由宿主注入**（`options.photon`），缺省时只查
// base64 字节上限并原样投递限内图片 —— 理由与「未对齐的一截」见 `image-process.ts` 文件头。
// 人类裁决 2026-10-02：能力与接口向 pi-coding-agent 对齐，`autoResizeImages` / `resizeOptions` 现在**真的被消费**。
import { Type } from 'typebox';
import { FileError } from '@earendil-works/pi-durable/env';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, utf8ByteLength } from './truncate.js';
import { resolveReadPathAsync } from './path-utils.js';
import { throwIfAborted } from './fs-ops.js';
import { processImage } from './image-process.js';
const readSchema = Type.Object({
    path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
    offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});
export const readToolSystemPromptContribution = {
    snippet: 'Read file contents',
    guidelines: ['Use read to examine files instead of cat or sed.'],
};
const readToolDescription = `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;
/** 与上游 `Buffer.toString('utf-8')` 等价：`ignoreBOM: true` 表示不吞掉开头的 BOM（默认会吞）。 */
const _decoder = new TextDecoder('utf-8', { ignoreBOM: true });
/** 浏览器没有默认文件系统（D5）：缺省即响亮报错，不静默用一个坏默认。 */
function requireOperations(options) {
    const operations = options?.operations;
    if (operations === undefined) {
        throw new Error('read tool: 浏览器没有默认文件系统，请在 options.operations 注入 ReadOperations（D5）');
    }
    return operations;
}
/**
 * 上游 `read.js:24-29`（逐字）：模型不支持 image 时在文本块里追加一行说明。
 * 与 `processImage` 无关 —— D6/R1 裁掉缩放时被连带动掉了，这里补回。
 */
function getNonVisionImageNote(model) {
    if (!model || model.input.includes('image'))
        return undefined;
    return '[Current model does not support images. The image will be omitted from this request.]';
}
/**
 * 上游 `read.js:41-60` 的形状：abort 事件一到就 reject，**不等执行体里那次挂起的 I/O**。
 * 只靠 `throwIfAborted` 检查点的话，注入的慢 I/O（IDB / 远端）挂起期间取消不生效。
 * 内层执行体之后的拒绝被吞掉（已经 reject 过了），但仍接住它，避免 unhandled rejection。
 */
function abortable(signal, run) {
    if (!signal)
        return run();
    if (signal.aborted)
        return Promise.reject(new FileError('aborted', 'Operation aborted'));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new FileError('aborted', 'Operation aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        run().then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (err) => { signal.removeEventListener('abort', onAbort); if (!signal.aborted)
            reject(err); });
    });
}
/** 共享执行体：`cwd` 已解析好（定义件传 `ctx?.cwd`，工厂件传构造期 cwd）。 */
async function executeRead(cwd, input, signal, operations, model, image) {
    throwIfAborted(signal);
    const absolutePath = await resolveReadPathAsync(input.path, cwd, (path) => operations.access(path));
    throwIfAborted(signal);
    // 与上游一致：解析完再显式确认一次可读（变体全不中时会回退未校验的原路径）
    await operations.access(absolutePath);
    throwIfAborted(signal);
    const mimeType = operations.detectImageMimeType ? await operations.detectImageMimeType(absolutePath) : undefined;
    if (mimeType) {
        const bytes = await operations.readFile(absolutePath);
        throwIfAborted(signal);
        // 上游 `read.js:60-90` 的形状：processImage 决定「原样 / 缩放 / 省略」，省略时只回文本说明。
        // `resizeOptions` 的优先级也同上游：模型自带的 resize 档优先于构造期的兜底档。
        const nonVisionImageNote = getNonVisionImageNote(model);
        const processed = await processImage(bytes, mimeType, {
            autoResizeImages: image?.autoResizeImages,
            resizeOptions: model?.inputLimits?.images?.resize ?? image?.resizeOptions,
            photon: image?.photon,
        });
        let textNote;
        let imageBlock;
        if (!processed.ok) {
            textNote = `Read image file [${mimeType}]\n${processed.message}`;
        }
        else {
            textNote = `Read image file [${processed.mimeType}]`;
            if (processed.hints.length > 0)
                textNote += `\n${processed.hints.join('\n')}`;
            imageBlock = { type: 'image', data: processed.data, mimeType: processed.mimeType };
        }
        // 上游 `read.js:76/85`：这句说明追加在**文本 note** 末尾（不是最后一个块——成功分支最后是 image 块）
        if (nonVisionImageNote)
            textNote += `\n${nonVisionImageNote}`;
        const content = imageBlock
            ? [{ type: 'text', text: textNote }, imageBlock]
            : [{ type: 'text', text: textNote }];
        return { content, details: undefined };
    }
    const textContent = _decoder.decode(await operations.readFile(absolutePath));
    throwIfAborted(signal);
    const allLines = textContent.split('\n');
    const totalFileLines = allLines.length;
    const startLine = input.offset ? Math.max(0, input.offset - 1) : 0;
    const startLineDisplay = startLine + 1;
    if (startLine >= allLines.length) {
        throw new FileError('invalid', `Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`);
    }
    let selectedContent;
    let userLimitedLines;
    if (input.limit !== undefined) {
        const endLine = Math.min(startLine + input.limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join('\n');
        userLimitedLines = endLine - startLine;
    }
    else {
        selectedContent = allLines.slice(startLine).join('\n');
    }
    const truncation = truncateHead(selectedContent);
    let outputText;
    let details;
    if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(utf8ByteLength(allLines[startLine]));
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
    }
    else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === 'lines') {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        }
        else {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
        details = { truncation };
    }
    else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    }
    else {
        outputText = truncation.content;
    }
    return { content: [{ type: 'text', text: outputText }], details };
}
export function createReadToolDefinition(cwd, options) {
    const operations = requireOperations(options);
    return {
        name: 'read',
        label: 'read',
        description: readToolDescription,
        promptSnippet: readToolSystemPromptContribution.snippet,
        promptGuidelines: [...readToolSystemPromptContribution.guidelines],
        parameters: readSchema,
        execute: (toolCallId, input, signal, _onUpdate, ctx) => abortable(signal, () => executeRead(ctx?.cwd || cwd, input, signal, operations, ctx?.model, options)),
    };
}
export function createReadTool(cwd, options) {
    const operations = requireOperations(options);
    return {
        name: 'read',
        label: 'read',
        description: readToolDescription,
        parameters: readSchema,
        // 同样包 `abortable`：上游的 `createReadTool` 是 `wrapToolDefinition(createReadToolDefinition(...))`，
        // 天然继承定义件里那个 abort 监听器；本仓两个工厂各写一份 execute（wrapper 不导出），
        // 工厂件漏包的话，**大多数消费者走的这条路**就没有「取消立即 reject」。
        execute: (toolCallId, input, signal, _onUpdate) => abortable(signal, () => executeRead(cwd, input, signal, operations, undefined, options)),
    };
}
