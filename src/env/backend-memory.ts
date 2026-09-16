// src/env/backend-memory.ts —— pi `FileSystem` 的内存后端（内部件：不进 src/index.ts 公开面）。
// 源：spice `packages/harness/src/session/fs-adapters.ts:87-238`（Plan 7b T6a），函数体逐字平移，
// 只做三处改名：类型 SpiceFileSystem → BrowserFileSystem、normalizePath 改从 ./path 导入、
// 模块级 helper basename 就地复制（fs-adapters.ts:70 逐字相同；两后端各自自足，本批不建共享 utils 文件）。
import { FileError, ok, err, type FileInfo, type Result } from '@earendil-works/pi-agent-core';
import { normalizePath } from './path';
import type { BrowserFileSystem } from './types';

const basename = (p: string): string => normalizePath(p).split('/').filter(Boolean).pop() ?? '';

/**
 * 纯内存 FileSystem（pi 契约）：Node / jsdom / 单测用。
 *
 * 为什么不用 lightning-fs 的 `MemoryBackend`：实测该注入在本仓锁定的 0.25.x 构建里不可靠
 * （Node 下创建即挂住、jsdom 下仍走 IndexedDB 后端并抛 `indexedDB is not defined`）。
 * 会话存储不需要闪电文件系统的任何特性（无 git、无大文件），Map 版 80 行足够且确定。
 */
export function createMemoryFileSystem(cwdInput = '/'): BrowserFileSystem {
	// data 存文本、bytes 存二进制（互斥）；两者都留以支持 writeFile(文本) → readBinaryFile 的混用
	type Node = { kind: 'file' | 'directory'; data?: string; bytes?: Uint8Array; mtimeMs: number };
	const files = new Map<string, Node>([['/', { kind: 'directory', mtimeMs: 0 }]]);
	const cwd = normalizePath(cwdInput);
	const notFound = (p: string) => new FileError('not_found', `Not found: ${p}`, p);
	const isDir = (p: string) => files.get(p)?.kind === 'directory';
	/** 逐段校验父路径（与 lightning-fs 版同一语义：路径穿过文件即不存在） */
	const parentOk = (abs: string): boolean => {
		const segs = abs.split('/').filter(Boolean);
		let cur = '';
		for (let i = 0; i < segs.length - 1; i++) {
			cur += `/${segs[i]}`;
			if (!isDir(cur)) return false;
		}
		return true;
	};
	const mkdirp = (dir: string) => {
		const segs = normalizePath(dir).split('/').filter(Boolean);
		let cur = '';
		for (const seg of segs) {
			cur += `/${seg}`;
			if (!files.has(cur)) files.set(cur, { kind: 'directory', mtimeMs: Date.now() });
		}
	};
	const info = (abs: string): FileInfo => {
		const n = files.get(abs)!;
		return { name: basename(abs), path: abs, kind: n.kind, size: n.bytes?.length ?? n.data?.length ?? 0, mtimeMs: n.mtimeMs };
	};
	const okv = <T>(v: T): Result<T, FileError> => ok(v);

	return {
		cwd,
		absolutePath: async (path: string) => okv(normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)),
		joinPath: async (parts: string[]) => okv(normalizePath(parts.join('/'))),
		canonicalPath: async (path: string) => okv(normalizePath(path)),
		readTextFile: async (path) => {
			const abs = normalizePath(path);
			const n = files.get(abs);
			if (!n || n.kind !== 'file') return err(notFound(abs));
			return okv(n.bytes ? new TextDecoder().decode(n.bytes) : n.data ?? '');
		},
		readBinaryFile: async (path) => {
			const abs = normalizePath(path);
			const n = files.get(abs);
			if (!n || n.kind !== 'file') return err(notFound(abs));
			return okv(n.bytes ?? new TextEncoder().encode(n.data ?? ''));
		},
		readTextLines: async (path, options) => {
			const abs = normalizePath(path);
			const n = files.get(abs);
			if (!n || n.kind !== 'file') return err(notFound(abs));
			const lines = (n.bytes ? new TextDecoder().decode(n.bytes) : n.data ?? '').split('\n');
			return okv(options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines);
		},
		writeFile: async (path, content) => {
			const abs = normalizePath(path);
			mkdirp(abs.split('/').slice(0, -1).join('/'));
			files.set(abs, typeof content === 'string'
				? { kind: 'file', data: content, mtimeMs: Date.now() }
				: { kind: 'file', bytes: new Uint8Array(content), mtimeMs: Date.now() });
			return okv(undefined);
		},
		appendFile: async (path, content) => {
			const abs = normalizePath(path);
			mkdirp(abs.split('/').slice(0, -1).join('/'));
			const prevNode = files.get(abs);
			const prev = prevNode?.bytes ? new TextDecoder().decode(prevNode.bytes) : prevNode?.data ?? '';
			const next = typeof content === 'string' ? content : new TextDecoder().decode(content);
			files.set(abs, { kind: 'file', data: prev + next, mtimeMs: Date.now() });
			return okv(undefined);
		},
		renameFile: async (src, dest) => {
			const from = normalizePath(src); const to = normalizePath(dest);
			const n = files.get(from);
			if (!n) return err(notFound(from));
			mkdirp(to.split('/').slice(0, -1).join('/'));
			files.set(to, { ...n, mtimeMs: Date.now() });
			files.delete(from);
			return okv(undefined);
		},
		fileInfo: async (path) => {
			const abs = normalizePath(path);
			if (!files.has(abs) || !parentOk(abs)) return err(notFound(abs));
			return okv(info(abs));
		},
		listDir: async (path) => {
			const abs = normalizePath(path);
			if (!isDir(abs)) return err(files.has(abs) ? new FileError('not_directory', `Not a directory: ${abs}`, abs) : notFound(abs));
			const prefix = abs === '/' ? '/' : `${abs}/`;
			const names = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix) || key === abs) continue;
				const rest = key.slice(prefix.length);
				if (rest.length > 0) names.add(rest.split('/')[0]);
			}
			return okv([...names].sort().map((n) => info(prefix + n)));
		},
		exists: async (path) => {
			const abs = normalizePath(path);
			return okv(files.has(abs) && parentOk(abs));
		},
		createDir: async (path, options) => {
			const abs = normalizePath(path);
			if (options?.recursive === false) {
				if (files.has(abs)) return err(new FileError('invalid', `Already exists: ${abs}`, abs));
				mkdirp(abs.split('/').slice(0, -1).join('/'));
				files.set(abs, { kind: 'directory', mtimeMs: Date.now() });
				return okv(undefined);
			}
			mkdirp(abs);
			return okv(undefined);
		},
		remove: async (path, options) => {
			const abs = normalizePath(path);
			if (!files.has(abs)) {
				if (options?.force) return okv(undefined);
				return err(notFound(abs));
			}
			if (isDir(abs)) {
				if (!options?.recursive) return err(new FileError('is_directory', `Is a directory: ${abs}`, abs));
				for (const key of [...files.keys()]) if (key.startsWith(`${abs}/`)) files.delete(key);
				files.delete(abs);
				return okv(undefined);
			}
			files.delete(abs);
			return okv(undefined);
		},
		createTempDir: async (prefix) => {
			const dir = `/tmp/${prefix ?? 'tmp-'}${Math.random().toString(36).slice(2, 10)}`;
			mkdirp(dir);
			return okv(dir);
		},
		createTempFile: async (options) => {
			mkdirp('/tmp');
			const file = `/tmp/${options?.prefix ?? ''}${Math.random().toString(36).slice(2, 10)}${options?.suffix ?? ''}`;
			files.set(file, { kind: 'file', data: '', mtimeMs: Date.now() });
			return okv(file);
		},
		cleanup: async () => { /* 无资源需释放 */ },
		// 内存 FS 无 debounce，写入即时完成；同形接口让上层统一调用（见 BrowserFileSystem.flush）
		flush: async () => { /* no-op */ },
	};
}
