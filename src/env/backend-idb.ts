// src/env/backend-idb.ts —— pi `FileSystem` 的 lightning-fs/IDB 后端（浏览器持久面）。
// 源：spice `packages/harness/src/session/fs-adapters.ts:24-35,59-86,240-393`（Plan 7b T6a），
// 逻辑逐字平移：mapError/isNotFound/LfsStats/useMemoryBackend/basename 与工厂函数体均只做改名
// Spice* → Browser*、normalizePath 改从 ./path 导入、createMemoryFileSystem 改从 ./backend-memory 导入。
import LightningFS from '@isomorphic-git/lightning-fs';
import { FileError, ok, err, type FileInfo, type Result } from '@earendil-works/pi-agent-core';
import { normalizePath } from './path';
import { createMemoryFileSystem } from './backend-memory';
import type { BrowserFileSystem } from './types';

type MemoryBackendCtor = new () => LightningFS.IDB;
const MemoryBackend = (LightningFS as unknown as { MemoryBackend: MemoryBackendCtor }).MemoryBackend;

/**
 * 是否需要内存后端（lightning-fs 默认后端是 IndexedDB）。
 *
 * 判据在**每次创建实例时**求值，不用模块级快照——踩过的坑：web 单测里有的文件会 `vi.stubGlobal('indexedDB', …)`
 * 再撤销，模块级快照可能落在「stub 存在」的窗口里，之后真用时 indexedDB 已消失 → ReferenceError。
 * 没有 IndexedDB 的运行环境一律走内存后端；测试如果需要特定后端，应显式传入 memory 选项。
 *
 * 显式 `memory: false` 优先于无 IndexedDB 的自动内存判定，允许测试和调用方强制验证 lightning-fs/IDB 路径。
 */
function useMemoryBackend(explicit?: boolean): boolean {
	if (explicit === false) return false;
	if (explicit === true) return true;
	if (typeof indexedDB === 'undefined') return true;
	return false;
}

type LfsStats = { type?: string; size?: number; mtimeMs?: number; isDirectory?: () => boolean; isFile?: () => boolean };

export interface BrowserFileSystemOptions {
	/** IndexedDB 库名（浏览器）/ 锁名前缀（Node）；默认 'spice-sessions' */
	dbName?: string;
	/** pi `FileSystem.cwd`（相对路径解析基准）；默认 '/' */
	cwd?: string;
	/** 测试注入：复用已有 lightning-fs 实例 */
	fs?: LightningFS;
	/** 强制内存后端（默认：无 indexedDB 或 vitest 环境下自动内存）；`false` 强制 lightning-fs/IDB */
	memory?: boolean;
}

const basename = (p: string): string => normalizePath(p).split('/').filter(Boolean).pop() ?? '';

function mapError(e: unknown, path: string): FileError {
	if (e instanceof FileError) return e;   // 适配层自己造的（如逐段校验判定不存在）
	const code = String((e as { code?: string })?.code ?? '');
	switch (code) {
		case 'ENOENT': return new FileError('not_found', `Not found: ${path}`, path, e as Error);
		case 'ENOTDIR': return new FileError('not_directory', `Not a directory: ${path}`, path, e as Error);
		case 'EISDIR': return new FileError('is_directory', `Is a directory: ${path}`, path, e as Error);
		case 'EACCES':
		case 'EPERM': return new FileError('permission_denied', `Permission denied: ${path}`, path, e as Error);
		case 'EEXIST': return new FileError('invalid', `Already exists: ${path}`, path, e as Error);
		default: return new FileError('unknown', (e as Error)?.message ?? String(e), path, e as Error);
	}
}

const isNotFound = (e: unknown): boolean => String((e as { code?: string })?.code ?? '') === 'ENOENT';

/** 落 lightning-fs 的文件系统能力（pi FileSystem 契约）。Node/单测走纯内存实现（自愈与该判据同源） */
export function createBrowserFileSystem(o: BrowserFileSystemOptions = {}): BrowserFileSystem {
	if (!o.fs && useMemoryBackend(o.memory)) return createMemoryFileSystem(o.cwd ?? '/');
	const dbName = o.dbName ?? 'spice-sessions';
	const makeMemoryFs = (): LightningFS => new LightningFS(dbName, { db: new MemoryBackend() });
	let usingMemory = useMemoryBackend(o.memory) || o.fs !== undefined;
	let fs = o.fs ?? (usingMemory ? makeMemoryFs() : new LightningFS(dbName));
	const cwd = normalizePath(o.cwd ?? '/');

	/**
	 * 所有 fs 操作统一走这里：**IndexedDB 后端初始化失败时自愈切内存后端重试一次**。
	 * 为什么需要：lightning-fs 的默认后端在「声明有 indexedDB、实际调用时又没了」的环境里会抛
	 * `ReferenceError: indexedDB is not defined`（jsdom 单测中 stub 被撤销时就这一种），
	 * 而按环境嗅探无法覆盖全部时序；自愈比嗅探可靠。（浏览器里 indexedDB 正常，不会触发。）
	 */
	async function onFs<T>(fn: (f: LightningFS) => Promise<T>): Promise<T> {
		try { return await fn(fs); }
		catch (e) {
			const msg = String((e as Error)?.message ?? '');
			if (!usingMemory && /indexedDB is not defined/.test(msg)) {
				usingMemory = true;
				fs = makeMemoryFs();
				return await fn(fs);
			}
			throw e;
		}
	}

	async function mkdirp(dir: string): Promise<void> {
		const abs = normalizePath(dir);
		if (abs === '/') return;
		let cur = '';
		for (const seg of abs.split('/').filter(Boolean)) {
			cur += `/${seg}`;
			try { await onFs((f) => f.promises.mkdir(cur)); } // eslint-disable-line no-await-in-loop
			catch (e) { if (!isNotFound(e) && String((e as { code?: string }).code) !== 'EEXIST') throw e; }
		}
	}

	/**
	 * 逐段 stat：lightning-fs 对「路径穿过一个文件」异常宽容（实测 stat('/f.txt/child') 返回文件本身的
	 * stat 而不报 ENOTDIR）——pi 的契约要求诚实回答存在性，所以这里自己走一遍，任一中间段不是目录即判不存在。
	 */
	async function statChecked(abs: string): Promise<LfsStats | null> {
		const segs = abs.split('/').filter(Boolean);
		let cur = '';
		for (let i = 0; i < segs.length; i++) {
			cur += `/${segs[i]}`;
			let st: LfsStats;
			try { st = (await onFs((f) => f.promises.stat(cur))) as LfsStats; }
			catch (e) { if (isNotFound(e)) return null; throw e; }
			const isDir = st.isDirectory ? st.isDirectory() : st.type === 'dir';
			if (i < segs.length - 1 && !isDir) return null;
			if (i === segs.length - 1) return st;
		}
		return null;
	}

	async function statInfo(path: string): Promise<FileInfo> {
		const abs = normalizePath(path);
		const st = await statChecked(abs);
		if (!st) throw new FileError('not_found', `Not found: ${abs}`, abs);
		const isDir = st.isDirectory ? st.isDirectory() : st.type === 'dir';
		return { name: basename(abs), path: abs, kind: isDir ? 'directory' : 'file', size: st.size ?? 0, mtimeMs: st.mtimeMs ?? 0 };
	}

	/** 递归删除（lightning-fs 的 rmdir 只删空目录） */
	async function removeRecursive(path: string): Promise<void> {
		const abs = normalizePath(path);
		const st = (await onFs((f) => f.promises.stat(abs))) as LfsStats;
		const isDir = st.isDirectory ? st.isDirectory() : st.type === 'dir';
		if (!isDir) { await onFs((f) => f.promises.unlink(abs)); return; }
		for (const child of await onFs((f) => f.promises.readdir(abs))) await removeRecursive(`${abs}/${child}`);
		await onFs((f) => f.promises.rmdir(abs, undefined));
	}

	const wrap = async <T>(path: string, fn: () => Promise<T>): Promise<Result<T, FileError>> => {
		try { return ok<T, FileError>(await fn()); }
		catch (e) { return err<T, FileError>(mapError(e, normalizePath(path))); }
	};

	return {
		cwd,
		absolutePath: async (path: string) => ok(normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)),
		joinPath: async (parts: string[]) => ok(normalizePath(parts.join('/'))),

		readTextFile: (path) => wrap(path, () => onFs((f) => f.promises.readFile(normalizePath(path), 'utf8'))),
		readBinaryFile: (path) => wrap(path, () => onFs((f) => f.promises.readFile(normalizePath(path)))),
		readTextLines: (path, options) => wrap(path, async () => {
			const text = await onFs((f) => f.promises.readFile(normalizePath(path), 'utf8'));
			const lines = text.split('\n');
			return options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines;
		}),
		writeFile: (path, content) => wrap(path, async () => {
			const abs = normalizePath(path);
			await mkdirp(abs.split('/').slice(0, -1).join('/'));
			await onFs((f) => f.promises.writeFile(abs, content));
		}),
		// lightning-fs 无 appendFile：读旧内容拼接（会话 JSONL 追加走这里，文件不大）
		appendFile: (path, content) => wrap(path, async () => {
			const abs = normalizePath(path);
			await mkdirp(abs.split('/').slice(0, -1).join('/'));
			let prev = '';
			try { prev = await onFs((f) => f.promises.readFile(abs, 'utf8')); } catch (e) { if (!isNotFound(e)) throw e; }
			const next = typeof content === 'string' ? content : new TextDecoder().decode(content);
			await onFs((f) => f.promises.writeFile(abs, prev + next));
		}),
		renameFile: (src, dest) => wrap(src, async () => {
			const to = normalizePath(dest);
			await mkdirp(to.split('/').slice(0, -1).join('/'));
			await onFs((f) => f.promises.rename(normalizePath(src), to));
		}),
		fileInfo: (path) => wrap(path, () => statInfo(path)),
		listDir: (path) => wrap(path, async () => {
			const abs = normalizePath(path);
			const names = await onFs((f) => f.promises.readdir(abs));
			return Promise.all(names.map((n) => statInfo(`${abs}/${n}`)));
		}),
		// lightning-fs 无符号链接：归一化即规范路径
		canonicalPath: async (path: string) => ok(normalizePath(path)),
		// pi 契约：缺失路径返 false；权限类失败才返 FileError（lightning-fs 无权限概念 → 基本只有 false 分支）
		exists: (path) => wrap(path, async () => (await statChecked(normalizePath(path))) !== null),
		createDir: (path, options) => wrap(path, async () => {
			const abs = normalizePath(path);
			if (options?.recursive === false) await onFs((f) => f.promises.mkdir(abs));
			else await mkdirp(abs);
		}),
		remove: (path, options) => wrap(path, async () => {
			const abs = normalizePath(path);
			try {
				if (options?.recursive) await removeRecursive(abs);
				else await onFs((f) => f.promises.unlink(abs));
			} catch (e) {
				if (isNotFound(e) && options?.force) return;   // force：不存在视为成功
				throw e;
			}
		}),
		createTempDir: (prefix) => wrap('/', async () => {
			const dir = `/tmp/${prefix ?? 'tmp-'}${Math.random().toString(36).slice(2, 10)}`;
			await mkdirp(dir);
			return dir;
		}),
		createTempFile: (options) => wrap('/', async () => {
			const file = `/tmp/${options?.prefix ?? ''}${Math.random().toString(36).slice(2, 10)}${options?.suffix ?? ''}`;
			await mkdirp('/tmp');
			await onFs((f) => f.promises.writeFile(file, ''));
			return file;
		}),
		// lightning-fs 无 close；实例生命周期由调用方（web 端单例）持有
		cleanup: async () => { /* 无资源需释放 */ },
		// 强制把超级块（目录树）写入 IDB，绕开 lightning-fs 的 500ms debounce（见 BrowserFileSystem.flush）
		flush: async () => { await onFs((f) => f.promises.flush()); },
	};
}
