// src/env/text-line-reader.ts —— `FileSystem.openTextLineReader` 的实现件（pi 0.99.1 新增的契约方法）。
//
// 为何单独一件：memory / idb 两个后端都要它，且语义只有一份（上游 `NodeTextLineReader` 的等价物，见
// @earendil-works/pi-agent-core@0.99.1 `dist/harness/env/nodejs.js`）——按 '\n' 切分、**保留末行是否带换行**
// （`terminated`）。这一位是硬需求：上游 `readJsonlHeader` 用 `line.terminated === false` 判定截断的存储文件，
// 少了它「文件写了一半」会被当成合法会话读进来。
//
// 与 Node 版的差别：两个浏览器后端都先把整份文本读进内存（lightning-fs 无真正的流式读），故这里直接从
// 字符串切，不做分块解码。契约其余部分照抄：`close` 幂等且不抛；关闭后 `readLine` 返 invalid。
import { FileError, err, ok, type Context, type Result } from '@earendil-works/pi-agent-core';

// 结构上与上游 `TextLine` / `TextLineReader`（pi-agent-core `dist/harness/types.d.ts`）一致。
// 不复用上游类型：这两个名字没有从包入口导出（上游只导出 `FileSystem`），deep import 会随内部重构漂。
interface TextLine { text: string; terminated: boolean }
interface TextLineReader {
	readLine(context: Context): Promise<Result<TextLine | undefined, FileError>>;
	close(context: Context): Promise<void>;
}

/**
 * 从**已读入内存的整份文本**建一个拉取式行读取器。
 *
 * 切分规则（与上游逐字对齐）：
 * - `"a\nb\n"` → `{a,true}`、`{b,true}`、`undefined`（结尾换行**不**产生幽灵空行）
 * - `"a\nb"`   → `{a,true}`、`{b,false}`、`undefined`（末行未终结）
 * - `""`       → `undefined`（空文件无行）
 */
export function createTextLineReader(text: string, path: string): TextLineReader {
	let remaining = text;
	let closed = false;
	return {
		readLine: async () => {
			if (closed) return err(new FileError('invalid', 'Text line reader is closed', path));
			const newline = remaining.indexOf('\n');
			if (newline !== -1) {
				const line = remaining.slice(0, newline);
				remaining = remaining.slice(newline + 1);
				return ok({ text: line, terminated: true });
			}
			if (remaining.length === 0) return ok(undefined);
			const line = remaining;
			remaining = '';
			return ok({ text: line, terminated: false });
		},
		close: async () => {
			closed = true;
			remaining = '';
		},
	};
}
