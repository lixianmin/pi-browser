// test/helpers/tool-operations.ts —— BrowserFileSystem → 工具 operations 的测试适配层（P2b/P2c）。
// 只存在于测试：生产代码里 operations 由调用方按 D5 注入，本仓不造「默认 operations」这种自造名。
import { BACKGROUND_CONTEXT } from '../../src/env/context';
import type { BrowserFileSystem } from '../../src/env/types';
import type { FileError, Result } from '@earendil-works/pi-durable/env';
import type { ReadOperations } from '../../src/tools/read-tool';
import type { WriteOperations } from '../../src/tools/write-tool';
import type { EditOperations } from '../../src/tools/edit-tool';
import type { GrepOperations } from '../../src/tools/grep-tool';
import type { FindOperations } from '../../src/tools/find-tool';
import { detectSupportedImageMimeType } from '../../src/tools/image-mime';
import picomatch from '../../src/tools/picomatch-typed';
import { displayPath, listTree } from '../../src/tools/fs-ops';

const unwrap = <T>(result: Result<T, FileError>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const readBytes = async (fs: BrowserFileSystem, path: string): Promise<Uint8Array> => unwrap(await fs.readBinaryFile(path, BACKGROUND_CONTEXT));

export const readOps = (fs: BrowserFileSystem): ReadOperations => ({
	readFile: (absolutePath) => readBytes(fs, absolutePath),
	access: async (absolutePath) => {
		unwrap(await fs.fileInfo(absolutePath, BACKGROUND_CONTEXT));
	},
	detectImageMimeType: async (absolutePath) => detectSupportedImageMimeType(await readBytes(fs, absolutePath)),
});

export const writeOps = (fs: BrowserFileSystem): WriteOperations => ({
	writeFile: async (absolutePath, content) => {
		unwrap(await fs.writeFile(absolutePath, content, BACKGROUND_CONTEXT));
	},
	mkdir: async (dir) => {
		unwrap(await fs.createDir(dir, { recursive: true }, BACKGROUND_CONTEXT));
	},
});

export const editOps = (fs: BrowserFileSystem): EditOperations => ({
	readFile: (absolutePath) => readBytes(fs, absolutePath),
	writeFile: async (absolutePath, content) => {
		unwrap(await fs.writeFile(absolutePath, content, BACKGROUND_CONTEXT));
	},
	access: async (absolutePath) => {
		unwrap(await fs.fileInfo(absolutePath, BACKGROUND_CONTEXT));
	},
});

export const grepOps = (fs: BrowserFileSystem): GrepOperations => ({
	isDirectory: async (absolutePath) => unwrap(await fs.fileInfo(absolutePath, BACKGROUND_CONTEXT)).kind === 'directory',
	readFile: async (absolutePath) => unwrap(await fs.readTextFile(absolutePath, BACKGROUND_CONTEXT)),
});

export const findOps = (fs: BrowserFileSystem): FindOperations => ({
	exists: async (absolutePath) => unwrap(await fs.exists(absolutePath, BACKGROUND_CONTEXT)),
	glob: async (pattern, cwd, options) => {
		const match = picomatch(pattern);
		const tree = await listTree(fs, cwd, BACKGROUND_CONTEXT);
		return tree
			.filter((entry) => entry.kind !== 'directory' && match(displayPath(entry.path, cwd)))
			.map((entry) => entry.path)
			.slice(0, options.limit);
	},
});
