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
 * fs 内核注册表（工程 fs 边界重构 spec §3，2026-09-21）：**同 dbName = 同世界**。
 *
 * lightning-fs 4.7.0 不按名去重实例（每个 `new` 新建 CacheFS 超块缓存，多实例 = 一方写另一方不可见、
 * 刷新后才对齐），同库跨闭包共享只能由这层做：持久路径（有 IndexedDB）按 dbName 复用同一 LightningFS；
 * 自动内存路径（无 IndexedDB，即两仓全部 vitest + 降级浏览器）同样按 dbName 键控
 * `LightningFS+MemoryBackend`——不能缓存 `createMemoryFileSystem`：它把 cwd 烤死在对象里、无多 cwd 视图原语。
 * 作用域是「每 JS 模块实例」（debugger 扩展自带一份 pi-browser 模块时与宿主仍是两内核，靠 Web Locks
 * Mutex2 + 写后 flush 共存，现状已如此）；测试跨用例用 `resetFsKernelRegistry()` 清表。
 */
const kernelRegistry = new Map<string, LightningFS>();
const kernelIsMemory = new Map<string, boolean>();

/** 测试专用逃生口：清空内核注册表——「同库新实例」durability 类测试清表后重开，断言的才是 IDB 落盘本身
 *  （否则命中同内核恒绿、不再测落盘）。先例：debugger handler.ts `resetHandlerCache()`。生产代码禁用。 */
export function resetFsKernelRegistry(): void {
	kernelRegistry.clear();
	kernelIsMemory.clear();
}

type LfsStats = { type?: string; size?: number; mtimeMs?: number; isDirectory?: () => boolean; isFile?: () => boolean };

export interface BrowserFileSystemOptions {
	/** IndexedDB 库名（浏览器）/ 锁名前缀（Node）；默认 'spice-sessions'。**同 dbName 共享同一内核**（注册表）。 */
	dbName?: string;
	/** pi `FileSystem.cwd`（相对路径解析基准）；默认 '/'。**cwd 不进注册表 key**——同库多 cwd 视图必须同世界。 */
	cwd?: string;
	/** 强制内存后端：**每调用独立纯内存世界**（createMemoryFileSystem），与注册表零交互（不查表/不写表/不缓存，
	 *  任意两次 memory:true 调用彼此也是独立世界）——测试/开发的隔离旋钮。
	 *  不传时：有 IndexedDB 走持久内核，无则自动内存（两者都入注册表，同 dbName 同世界）；
	 *  `memory: false` 强制 IDB 内核（配 fake-indexeddb 可测真 IndexedDB 路径）。 */
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

/** LFS 系 readFile 读目录返回 null（CacheFS stat 目录成功→按 ino 读空→DefaultBackend.readFile 得 null），
 *  memory 后端报 not_found——适配层统一归一为 not_found，三种内核面同契约（fs 边界重构 spec §3 收口）。 */
const ensureFileContent = <T>(v: T, path: string): T => {
	if (v === null || v === undefined) {
		throw Object.assign(new Error(`Not a file: ${normalizePath(path)}`), { code: 'ENOENT' });
	}
	return v;
};

/** 落 lightning-fs 的文件系统能力（pi FileSystem 契约）。Node/单测走纯内存实现（自愈与该判据同源） */
export function createBrowserFileSystem(o: BrowserFileSystemOptions = {}): BrowserFileSystem {
	// 显式 memory:true：每调用独立纯内存世界，**不碰注册表**（隔离旋钮，spec C3）。
	if (o.memory === true) return createMemoryFileSystem(o.cwd ?? '/');
	const dbName = o.dbName ?? 'spice-sessions';
	const makeMemoryFs = (): LightningFS => new LightningFS(dbName, { db: new MemoryBackend() });
	/** 从注册表现取当前 dbName 内核（**每次操作都取**，闭包不长期持有引用）：自愈把内存内核写回同 key 后，
	 *  先于自愈创建的其它同键闭包也立刻收敛到同一内核——若闭包捕获局部引用，会各自再自愈出 N 个内存世界，
	 *  先自愈者成数据孤儿（round-2 F4 钉死）。miss 时初始化：有 IDB 建 IDB 内核；无 IDB 直接建
	 *  MemoryBackend 内核（判据同源旧 useMemoryBackend：没 IDB 就别建注定抛 `indexedDB is not defined` 的内核）。 */
	const getKernel = (): LightningFS => {
		const cached = kernelRegistry.get(dbName);
		if (cached) return cached;
		const hasIdb = typeof indexedDB !== 'undefined';
		const kernel = hasIdb ? new LightningFS(dbName) : makeMemoryFs();
		kernelRegistry.set(dbName, kernel);
		kernelIsMemory.set(dbName, !hasIdb);
		return kernel;
	};
	const cwd = normalizePath(o.cwd ?? '/');

	/**
	 * 所有 fs 操作统一走这里：内核**每次现取**（getKernel，注册表收敛语义见上）+ **IndexedDB 后端初始化失败时
	 * 自愈切内存后端重试一次**（写回注册表同 key + per-dbName 标志，全体同键闭包收敛一个内存内核）。
	 * 为什么需要：lightning-fs 的默认后端在「声明有 indexedDB、实际调用时又没了」的环境里会抛
	 * `ReferenceError: indexedDB is not defined`（jsdom 单测中 stub 被撤销时就这一种），
	 * 而按环境嗅探无法覆盖全部时序；自愈比嗅探可靠。（浏览器里 indexedDB 正常，不会触发。）
	 */
	async function onFs<T>(fn: (f: LightningFS) => Promise<T>): Promise<T> {
		try { return await fn(getKernel()); }
		catch (e) {
			const msg = String((e as Error)?.message ?? '');
			if (!kernelIsMemory.get(dbName) && /indexedDB is not defined/.test(msg)) {
				kernelIsMemory.set(dbName, true);
				kernelRegistry.set(dbName, makeMemoryFs());
				return await fn(getKernel());
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

		readTextFile: (path) => wrap(path, () => onFs(async (f) => ensureFileContent(await f.promises.readFile(normalizePath(path), 'utf8'), path))),
		readBinaryFile: (path) => wrap(path, () => onFs(async (f) => ensureFileContent(await f.promises.readFile(normalizePath(path)), path))),
		readTextLines: (path, options) => wrap(path, async () => {
			const text = ensureFileContent(await onFs((f) => f.promises.readFile(normalizePath(path), 'utf8')), path);
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
				else {
					// 契约收口：非递删目录统一报 is_directory——LFS 系 unlink 对目录静默摘条目留孤儿，
					// 与 memory 后端（及 makeGitFs.rmdir 依赖的 shell-git-fidelity 验证语义）对齐。
					const st = (await onFs((f) => f.promises.stat(abs))) as LfsStats;
					const isDir = st?.isDirectory ? st.isDirectory() : st?.type === 'dir';
					if (isDir) throw Object.assign(new Error(`Is a directory: ${abs}`), { code: 'EISDIR' });
					await onFs((f) => f.promises.unlink(abs));
				}
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
