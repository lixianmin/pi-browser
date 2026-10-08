// src/env/pull-readers.ts —— `FileSystem.openBinaryReader` / `openDirReader` 的实现件
// （pi-durable 1.0.3 起 `FileSystem` 必填的两个契约方法）。
//
// 与 text-line-reader.ts 同一取舍：两个浏览器后端都先把整份字节读进内存（lightning-fs 无真正的流式读），
// 所以这里的读取器是**快照**：打开的那一刻是什么，之后改名/改写都不影响它。契约要的是
// 「路径改名后仍读到同一文件」，快照是它的加强版——浏览器后端没有句柄可挂。
//
// `scanLines` 的行号↔字节换算交给上游的 `LineScanner`：那是唯一一份实现，自己重写只会与上游漂。
import { FileError, LineScanner, err, ok, type BinaryReader, type DirReader, type FileInfo, type Result } from '@earendil-works/pi-durable/env';

/**
 * 从**已读入内存的整份字节**建一个定位式二进制读取器（上游 `NodeBinaryReader` 的等价物）。
 *
 * `info()` 报的是**打开时**那份文件的元信息（上游契约：不报路径现在指向的东西），所以由调用方把
 * 打开瞬间的 `FileInfo` 传进来。
 */
export function createBinaryReader(bytes: Uint8Array, opened: FileInfo, path: string): BinaryReader {
	let closed = false;
	const closedErr = (): Result<never, FileError> => err(new FileError('invalid', 'Binary reader is closed', path));
	return {
		info: async () => (closed ? closedErr() : ok(opened)),
		read: async (offset, length) => {
			if (closed) return closedErr();
			if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
				return err(new FileError('invalid', `Invalid read range: offset=${offset} length=${length}`, path));
			}
			// 越界只该在文件末尾少给：`subarray` 自动收敛到末尾
			return ok(bytes.subarray(offset, offset + length));
		},
		scanLines: async (options) => {
			if (closed) return closedErr();
			// 上游 `LineScanner` 的前置条件（`startLine`/`endLine` 是非负安全整数且 endLine > startLine）
			const { startLine, endLine } = options;
			const validRange = Number.isSafeInteger(startLine) && startLine >= 0
				&& (endLine === undefined || (Number.isSafeInteger(endLine) && endLine > startLine));
			if (!validRange) return err(new FileError('invalid', `Invalid line range: ${startLine}..${endLine}`, path));
			const scanner = new LineScanner(startLine, endLine);
			scanner.push(bytes);
			return ok(scanner.finish());
		},
		close: async () => { closed = true; },
	};
}

/**
 * 从**已列好的一页条目**建目录分页读取器（上游 `DirReader` 的等价物）。
 *
 * 快照语义：`entries` 在 open 时给定，之后不重列。契约里的「条目在读元信息前消失就跳过」在快照下
 * 无从发生——浏览器侧的目录都很小，为此保留重列逻辑不划算（§2）。
 */
export function createDirReader(entries: FileInfo[], path: string): DirReader {
	let cursor = 0;
	let closed = false;
	return {
		next: async (maxEntries) => {
			if (closed) return err(new FileError('invalid', 'Directory reader is closed', path));
			const page = entries.slice(cursor, cursor + maxEntries);
			cursor += page.length;
			return ok({ entries: page, done: cursor >= entries.length });
		},
		close: async () => { closed = true; },
	};
}