// src/env/backend-memory.ts —— pi `FileSystem` 的内存后端（内部件：不进 src/index.ts 公开面）。
// 源：spice `packages/harness/src/session/fs-adapters.ts:87-238`（Plan 7b T6a），函数体逐字平移，
// 只做三处改名：类型 SpiceFileSystem → BrowserFileSystem、normalizePath 改从 ./path 导入、
// 模块级 helper basename 就地复制（fs-adapters.ts:70 逐字相同；两后端各自自足，本批不建共享 utils 文件）。
import { FileError, ok, err, type FileInfo, type FileWatcher, type Result } from '@earendil-works/pi-durable/env';
import { normalizePath } from './path';
import { abortedResult, type Context } from './context';
import { createTextLineReader, readAllTextLines } from './text-line-reader';
import { createBinaryReader, createDirReader } from './pull-readers';
import type { BrowserFileSystem } from './types';

const basename = (p: string): string => normalizePath(p).split('/').filter(Boolean).pop() ?? '';
const ENCODER = new TextEncoder();

/**
 * 纯内存 FileSystem（pi 契约）：Node / jsdom / 单测用。
 *
 * 为什么不用 lightning-fs 的 `MemoryBackend`：实测该注入在本仓锁定的 0.25.x 构建里不可靠
 * （Node 下创建即挂住、jsdom 下仍走 IndexedDB 后端并抛 `indexedDB is not defined`）。
 * 会话存储不需要闪电文件系统的任何特性（无 git、无大文件），Map 版 80 行足够且确定。
 */
let memoryFsSeq = 0;   // id 的自增源（模块级计数，保证每实例唯一）

export function createMemoryFileSystem(cwdInput = '/'): BrowserFileSystem {
	// data 存文本、bytes 存二进制（互斥）；两者都留以支持 writeFile(文本) → readBinaryFile 的混用
	type Node = { kind: 'file' | 'directory'; data?: string; bytes?: Uint8Array; mtimeMs: number };
	const files = new Map<string, Node>([['/', { kind: 'directory', mtimeMs: 0 }]]);
	const cwd = normalizePath(cwdInput);
	const notFound = (p: string) => new FileError('not_found', `Not found: ${p}`, p);
	const dirErr = (p: string) => new FileError('is_directory', `Is a directory: ${p}`, p);
	/** 父路径链上第一个「存在但不是目录」的段（路径穿过文件）；全为目录或不存在返回 undefined。
	 *  上游对这类路径报 ENOTDIR → not_directory；不查就会在文件节点下挂出子节点（脏状态）。 */
	const nonDirAncestor = (abs: string): string | undefined => {
		const segs = abs.split('/').filter(Boolean);
		let cur = '';
		for (let i = 0; i < segs.length - 1; i++) {
			cur += `/${segs[i]}`;
			const n = files.get(cur);
			if (n && n.kind !== 'directory') return cur;
		}
		return undefined;
	};
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
		// 文本按 UTF-8 现算字节数：`data.length` 是 UTF-16 码元数，与 readBinaryFile 报的长度不一致
		return { name: basename(abs), path: abs, kind: n.kind, size: n.bytes?.length ?? ENCODER.encode(n.data ?? '').length, mtimeMs: n.mtimeMs };
	};
	const okv = <T>(v: T): Result<T, FileError> => ok(v);
	/** `listDir` 与 `openDirReader` 共用：直属条目按名排序 */
	const listEntries = (abs: string): Result<FileInfo[], FileError> => {
		if (!isDir(abs)) return err(files.has(abs) ? new FileError('not_directory', `Not a directory: ${abs}`, abs) : notFound(abs));
		const prefix = abs === '/' ? '/' : `${abs}/`;
		const names = new Set<string>();
		for (const key of files.keys()) {
			if (!key.startsWith(prefix) || key === abs) continue;
			const rest = key.slice(prefix.length);
			if (rest.length > 0) names.add(rest.split('/')[0]);
		}
		return okv([...names].sort().map((n) => info(prefix + n)));
	};
	/** 节点上的字节（文本节点按 UTF-8 现算），供 `readBinaryFile` 与 `openBinaryReader` 共用。
	 *  返回**副本**：节点是后端私有状态，把内部 Uint8Array 直接交给调用方（读取器再切 subarray）
	 *  意味着一次读后改字节就改了「存储」。IDB 后端每次都是结构化克隆，两边必须同口径。 */
	const bytesOf = (n: Node): Uint8Array => (n.bytes ? n.bytes.slice() : ENCODER.encode(n.data ?? ''));

	return {
		cwd,
		// 文件命名空间 id：memory 后端每次调用都是独立世界（不进注册表），所以每实例一个
		id: `memory-fs-${++memoryFsSeq}`,
		// pi-durable 1.0.0/1.0.3 起每个方法都收 `context` 形参；`abortSignal` 做**入口检查**
		// （`abortedResult`，同上游 `abortResult`）——已取消的调用返 `aborted` 且不产生副作用。
		// 上游不查的两个纯路径计算方法（`absolutePath` / `joinPath`）也不查；`cleanup` 同样不查。
		absolutePath: async (path: string, _context: Context) => okv(normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)),
		joinPath: async (parts: string[], _context: Context) => okv(normalizePath(parts.join('/'))),
		canonicalPath: async (path: string, context: Context) => {
			const aborted = abortedResult<string>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 上游走 realpath：路径不存在报 ENOENT → not_found。浏览器无 symlink 可解析，
			// 但仍要核实存在性——否则 canonicalPath 会把「不存在」与「存在」混为一谈。
			if (!files.has(abs) || !parentOk(abs)) return err(notFound(abs));
			return okv(abs);
		},
		readTextFile: async (path, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			const n = files.get(abs);
			if (!n) return err(notFound(abs));
			if (n.kind !== 'file') return err(dirErr(abs));
			return okv(n.bytes ? new TextDecoder().decode(n.bytes) : n.data ?? '');
		},
		readBinaryFile: async (path, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			const n = files.get(abs);
			if (!n) return err(notFound(abs));
			if (n.kind !== 'file') return err(dirErr(abs));
			return okv(bytesOf(n));
		},
		// pi-durable 1.0.3 新增的必填契约：打开后的定位式读。`noFollow` 无从谈起（内存后端无符号链接），
		// 目录按上游口径落 is_directory。抓的是打开瞬间那个节点对象，故此后改名不影响已开的读取器。
		openBinaryReader: async (path, _options, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			const n = files.get(abs);
			if (!n) return err(notFound(abs));
			if (n.kind === 'directory') return err(new FileError('is_directory', `Is a directory: ${abs}`, abs));
			return okv(createBinaryReader(bytesOf(n), info(abs), abs));
		},
		// 与上游 `NodeExecutionEnv` 同语义（0.99.1 起上游内部就是走行读取器）：结尾换行**不**产生幽灵空行、
		// 空文件返 []。旧版按 `split('\n')` 切，`"l1\nl2\n"` 会多出一行 `""`（已对齐上游）。
		readTextLines: async (path, options, context) => {
			// 上游同款短路：maxLines <= 0 连文件都不打开（缺失路径也返 ok([])）
			if (options?.maxLines !== undefined && options.maxLines <= 0) return okv<string[]>([]);
			const abs = normalizePath(path);
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			const n = files.get(abs);
			if (!n) return err(notFound(abs));
			if (n.kind !== 'file') return err(dirErr(abs));
			return readAllTextLines(createTextLineReader(n.bytes ? new TextDecoder().decode(n.bytes) : n.data ?? '', abs), options?.maxLines, context);
		},
		// 契约（pi 0.99.1 新增）：拉取式行读取，末行 `terminated` 必须诚实（见 text-line-reader.ts）
		openTextLineReader: async (path, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			const n = files.get(abs);
			if (!n) return err(notFound(abs));
			if (n.kind !== 'file') return err(dirErr(abs));
			return okv(createTextLineReader(n.bytes ? new TextDecoder().decode(n.bytes) : n.data ?? '', abs));
		},
		writeFile: async (path, content, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 类型冲突：目录不能被静默替换成文件（上游 writeFile 对目录报 EISDIR）
			if (isDir(abs)) return err(dirErr(abs));
			// 路径穿过文件：上游报 ENOTDIR；不查会建出「文件下挂子节点」的脏状态
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			mkdirp(abs.split('/').slice(0, -1).join('/'));
			files.set(abs, typeof content === 'string'
				? { kind: 'file', data: content, mtimeMs: Date.now() }
				: { kind: 'file', bytes: new Uint8Array(content), mtimeMs: Date.now() });
			return okv(undefined);
		},
		appendFile: async (path, content, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 类型冲突：目录不能被静默替换成文件（上游 appendFile 对目录报 EISDIR）
			if (isDir(abs)) return err(dirErr(abs));
			// 路径穿过文件：上游报 ENOTDIR
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			mkdirp(abs.split('/').slice(0, -1).join('/'));
			const prevNode = files.get(abs);
			const prev = prevNode?.bytes ? new TextDecoder().decode(prevNode.bytes) : prevNode?.data ?? '';
			const next = typeof content === 'string' ? content : new TextDecoder().decode(content);
			files.set(abs, { kind: 'file', data: prev + next, mtimeMs: Date.now() });
			return okv(undefined);
		},
		renameFile: async (src, dest, context) => {
			const aborted = abortedResult<never>(context, src);
			if (aborted) return aborted;
			const from = normalizePath(src); const to = normalizePath(dest);
			const n = files.get(from);
			if (!n) return err(notFound(from));
			// 自我 rename 是成功的 no-op（上游 fs.rename 同款）；不挡的话下面先 set 再 delete 同一个 key = 静默删文件
			if (from === to) return okv(undefined);
			// 根不可改名（上游 EBUSY）；不挡会把整个文件系统从 '/' 搬到一个子路径
			if (from === '/') return err(new FileError('unknown', 'Cannot rename the root directory', from));
			// 类型冲突：rename 到已存在目录（上游 EISDIR），不能把目录替换掉
			if (isDir(to)) return err(dirErr(to));
			// 目录移进自己的子树：上游 EINVAL；不挡会把子树 re-key 到自己的下面，树直接烂掉
			if (n.kind === 'directory' && to.startsWith(`${from}/`)) return err(new FileError('invalid', `Cannot move a directory into itself: ${to}`, to));
			const existing = files.get(to);
			if (n.kind === 'directory' && existing?.kind === 'file') return err(new FileError('not_directory', `Not a directory: ${to}`, to));
			// 路径穿过文件：上游 ENOTDIR（与 writeFile/createDir 同一道闸）
			const badParent = nonDirAncestor(to);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			mkdirp(to.split('/').slice(0, -1).join('/'));
			// 表按整路径索引：目录改名时子项也要跟着换 key（与 idb/lightning-fs 及 wasi-fs.renameSync 同语义）
			if (n.kind === 'directory') {
				for (const key of [...files.keys()]) {
					if (!key.startsWith(`${from}/`)) continue;
					files.set(`${to}${key.slice(from.length)}`, files.get(key)!);
					files.delete(key);
				}
			}
			files.set(to, { ...n, mtimeMs: Date.now() });
			files.delete(from);
			return okv(undefined);
		},
		fileInfo: async (path, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 上游区分：路径不存在 → not_found；路径**穿过一个文件** → not_directory（任意深度）
			// 旧实现只看直接父节点，'/f' 是文件时 '/f/a/b' 会被报成 not_found。
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			if (!files.has(abs)) return err(notFound(abs));
			if (!parentOk(abs)) return err(notFound(abs));
			return okv(info(abs));
		},
		listDir: async (path, context) =>
			abortedResult<FileInfo[]>(context, path) ?? listEntries(normalizePath(path)),
		// pi-durable 1.0.3 新增的必填契约：目录分页。条目在 open 时列一次（见 pull-readers.ts 的快照取舍）
		openDirReader: async (path, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			const listed = listEntries(abs);
			return listed.ok ? okv(createDirReader(listed.value, abs)) : listed;
		},
		exists: async (path, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			return okv(files.has(abs) && parentOk(abs));
		},
		createDir: async (path, options, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 路径穿过文件：上游报 ENOTDIR
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			// 类型冲突：已存在的**文件**不能被静默替换成目录（上游 EEXIST；spec §3 禁止对齐 unknown → invalid）
			if (files.get(abs)?.kind === 'file') return err(new FileError('invalid', `Already exists: ${abs}`, abs));
			if (options?.recursive === false) {
				if (files.has(abs)) return err(new FileError('invalid', `Already exists: ${abs}`, abs));
				// recursive:false 要求父目录已存在（上游 mkdir 报 ENOENT）；不能偷偷 mkdirp
				const parent = abs.split('/').slice(0, -1).join('/') || '/';
				if (parent !== '/' && !isDir(parent)) return err(notFound(parent));
				files.set(abs, { kind: 'directory', mtimeMs: Date.now() });
				return okv(undefined);
			}
			mkdirp(abs);
			return okv(undefined);
		},
		remove: async (path, options, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 删根之后整棵树都没了，所有路径变 ENOENT（上游 EBUSY）；与 wasi-fs.rmdirSync 同一道闸
			if (abs === '/') return err(new FileError('unknown', 'Cannot remove the root directory', abs));
			// 路径穿过文件：上游报 ENOTDIR（不能把「父路径是文件」当成「不存在」静默成功）
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
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
		createTempDir: async (prefix, context) => {
			const aborted = abortedResult<never>(context, prefix);
			if (aborted) return aborted;
			const dir = `/tmp/${prefix ?? 'tmp-'}${Math.random().toString(36).slice(2, 10)}`;
			mkdirp(dir);
			return okv(dir);
		},
		createTempFile: async (options, context) => {
			const aborted = abortedResult<never>(context, options?.prefix);
			if (aborted) return aborted;
			mkdirp('/tmp');
			const file = `/tmp/${options?.prefix ?? ''}${Math.random().toString(36).slice(2, 10)}${options?.suffix ?? ''}`;
			files.set(file, { kind: 'file', data: '', mtimeMs: Date.now() });
			return okv(file);
		},
		// pi 1.0.0 新增：截断或补零到正好 `size` 字节。`size` 校验与上游 NodeExecutionEnv 同款
		// （非负安全整数之外返 invalid）；缺文件返 not_found（上游先开 r+，开不到就没有下文）。
		// 内存后端是**立即分配**：`size` 就是一次 `new Uint8Array(size)` 的大小（上游 ftruncate 是稀疏扩），
		// 所以「合法的巨大 size」会当场吃掉对应内存（1e9 = 1GB）。本库没有调用方，先如实记着。
		truncateFile: async (path, size, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 路径穿过文件：上游 ENOTDIR（与读写/删同一道闸）
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			if (!Number.isSafeInteger(size) || size < 0) {
				return err<void, FileError>(new FileError('invalid', 'File size must be a non-negative safe integer', abs));
			}
			const n = files.get(abs);
			if (!n) return err(notFound(abs));
			if (n.kind !== 'file') return err(dirErr(abs));
			const bytes = n.bytes ?? ENCODER.encode(n.data ?? '');
			let next: Uint8Array;
			try {
				next = new Uint8Array(size);
			} catch (e) {
				// 合法但分配不下的 size（如 2**53-1）：契约是「不抛，返回 Result」（IDB 后端的 wrap 同一结果）
				return err(new FileError('unknown', `Cannot allocate ${size} bytes: ${(e as Error).message}`, abs, e as Error));
			}
			next.set(bytes.subarray(0, Math.min(size, bytes.length)));
			// 统一落成 bytes（不再是 data 字符串）：截断到非字符边界时字符串存不住
			files.set(abs, { kind: 'file', bytes: next, mtimeMs: Date.now() });
			return okv(undefined);
		},
		// pi 1.0.0 新增：内存后端没有落盘面，flush 是 no-op；但存在性照上游（开 r+）如实回答
		flushFile: async (path, context) => {
			const aborted = abortedResult<never>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			// 路径穿过文件：上游 ENOTDIR
			const badParent = nonDirAncestor(abs);
			if (badParent) return err(new FileError('not_directory', `Not a directory: ${badParent}`, badParent));
			const n = files.get(abs);
			if (!n) return err(notFound(abs));
			if (n.kind !== 'file') return err(dirErr(abs));
			return okv(undefined);
		},
		cleanup: async (_context: Context) => { /* 无资源需释放 */ },
		// pi-durable 1.0.3 新增的必填契约：浏览器没有 fs 事件源，**如实答不支持**，
		// 不假装返回「永不变化的 watcher」（那会让调用方一直等不到覆盖建立）。
		watch: async (targets, _onChange, context) =>
			abortedResult<FileWatcher>(context) ?? err(new FileError('not_supported', `内存 fs 不支持 watch: ${targets.map((t) => t.path).join(', ')}`)),
		// 内存 FS 无 debounce，写入即时完成；同形接口让上层统一调用（见 BrowserFileSystem.flush）
		flush: async () => { /* no-op */ },
	};
}
