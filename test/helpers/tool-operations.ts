// test/helpers/tool-operations.ts —— BrowserFileSystem → 工具 operations 的测试适配层（P2b Task 11–13）。
// 只存在于测试：生产代码里 operations 由调用方按 D5 注入，本仓不造「默认 operations」这种自造名。
import { BACKGROUND_CONTEXT } from '../../src/env/context';
import type { BrowserFileSystem } from '../../src/env/types';
import type { ReadOperations } from '../../src/tools/read-tool';
import type { WriteOperations } from '../../src/tools/write-tool';
import type { EditOperations } from '../../src/tools/edit-tool';
import { detectSupportedImageMimeType } from '../../src/tools/image-mime';

const readBytes = async (fs: BrowserFileSystem, path: string): Promise<Uint8Array> => {
	const r = await fs.readBinaryFile(path, BACKGROUND_CONTEXT);
	if (!r.ok) throw r.error;
	return r.value;
};

export const readOps = (fs: BrowserFileSystem): ReadOperations => ({
	readFile: (absolutePath) => readBytes(fs, absolutePath),
	access: async (absolutePath) => {
		await readBytes(fs, absolutePath);
	},
	detectImageMimeType: async (absolutePath) => detectSupportedImageMimeType(await readBytes(fs, absolutePath)),
});

export const writeOps = (fs: BrowserFileSystem): WriteOperations => ({
	writeFile: async (absolutePath, content) => {
		const r = await fs.writeFile(absolutePath, content, BACKGROUND_CONTEXT);
		if (!r.ok) throw r.error;
	},
	mkdir: async (dir) => {
		const r = await fs.createDir(dir, { recursive: true }, BACKGROUND_CONTEXT);
		if (!r.ok) throw r.error;
	},
});

export const editOps = (fs: BrowserFileSystem): EditOperations => ({
	readFile: (absolutePath) => readBytes(fs, absolutePath),
	writeFile: async (absolutePath, content) => {
		const r = await fs.writeFile(absolutePath, content, BACKGROUND_CONTEXT);
		if (!r.ok) throw r.error;
	},
	access: async (absolutePath) => {
		await readBytes(fs, absolutePath);
	},
});
