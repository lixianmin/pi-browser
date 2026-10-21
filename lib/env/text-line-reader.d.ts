import { type Context } from './context.js';
import { FileError, type Result } from '@earendil-works/pi-durable/env';
interface TextLine {
    text: string;
    terminated: boolean;
}
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
export declare function createTextLineReader(text: string, path: string): TextLineReader;
/**
 * 与上游 `readTextLines` 同语义：拉满 `maxLines` 或读到 EOF 才停，**最后必然 close**（上游同款）。
 *
 * 与上游的唯一差别是它在 `maxLines <= 0` 时**连文件都不打开**（缺失路径也返 `ok([])`）——那个短路在两后端里、
 * 开文件之前做（见 backend-memory / backend-idb 的 `readTextLines`），所以这里的 `maxLines` 恒为正或 undefined。
 */
export declare function readAllTextLines(reader: TextLineReader, maxLines: number | undefined, context: Context): Promise<Result<string[], FileError>>;
export {};
