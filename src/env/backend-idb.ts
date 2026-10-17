// src/env/backend-idb.ts —— pi `FileSystem` 的 lightning-fs/IDB 后端（浏览器持久面）。
// 源：spice `packages/harness/src/session/fs-adapters.ts:24-35,59-86,240-393`（Plan 7b T6a），
// 逻辑逐字平移：mapError/isNotFound/LfsStats/useMemoryBackend/basename 与工厂函数体均只做改名
// Spice* → Browser*、normalizePath 改从 ./path 导入、createMemoryFileSystem 改从 ./backend-memory 导入。
import LightningFS from '@isomorphic-git/lightning-fs';
import { FileError, ok, err, type FileInfo, type FileWatcher, type Result } from '@earendil-works/pi-durable/env';
import { normalizePath } from './path';
import { abortedResult, type Context } from './context';
import { createTextLineReader, readAllTextLines } from './text-line-reader';
import { createBinaryReader, createDirReader } from './pull-readers';
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
 *
 * `resetFsKernelRegistry()` 只清表、**不销毁旧内核**（lightning-fs 无公开销毁面）：旧内核 idle 500ms 后
 * 的 deactivate 仍会把它的超块写回同一 IDB（单键 '!root'，后写覆盖）。故其用法钉死为
 * 「reset → 重开 → 读回」；**reset 后不要对同一 dbName 继续写**（要与写入语义隔离）。
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
	 *  `memory: false` = 只用注册表内核（同 dbName 同世界；有 indexedDB 时是 IDB 内核，无 indexedDB 时是
	 *  MemoryBackend 内核——与旧「强制 IDB 再自愈」对外等价，配 fake-indexeddb 可测真 IDB 路径）。 */
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
		const used = getKernel();
		try { return await fn(used); }
		catch (e) {
			const msg = String((e as Error)?.message ?? '');
			// 自愈判定按「本次用的内核」而非仅标志位：同 tick 已有并发 op 自愈时，后到者拿到的 used 仍是坏内核，
			// 但注册表已换新——此时应直接用新内核重试（否则白抛，虽无数据损坏但错误更响）。
			const healed = kernelRegistry.get(dbName) !== used;
			if (/indexedDB is not defined/.test(msg) && (!kernelIsMemory.get(dbName) || healed)) {
				if (!healed) kernelRegistry.set(dbName, makeMemoryFs());
				kernelIsMemory.set(dbName, true);
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
		// 根目录在任何文件系统上都存在，而下面的逐段循环一次都不执行、会落到末尾 `return null`
		// ——于是 `exists('/')` 假、`fileInfo('/')` 报 not_found（`listDir('/')` 因为直接 readdir
		// 反而正常，所以这个洞很容易被漏掉）。修：根目录给一个合成的目录 stat。
		if (segs.length === 0) return { type: 'dir', size: 0, mtimeMs: 0 } as unknown as LfsStats;
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
		if (!st) {
			// 上游区分：路径不存在 → not_found；路径**穿过一个文件** → not_directory。
			// `statChecked` 逐段走时两者都返回 null，这里沿整条父链再查一次（旧实现只看直接父节点，
			// '/f' 是文件时 '/f/a/b' 被误报成 not_found）。
			const badParent = await nonDirAncestor(abs);
			if (badParent) throw new FileError('not_directory', `Not a directory: ${badParent}`, badParent);
			throw new FileError('not_found', `Not found: ${abs}`, abs);
		}
		const isDir = st.isDirectory ? st.isDirectory() : st.type === 'dir';
		return { name: basename(abs), path: abs, kind: isDir ? 'directory' : 'file', size: st.size ?? 0, mtimeMs: st.mtimeMs ?? 0 };
	}

	/**
	 * 读文件内容，并把 lightning-fs 把「目标其实是目录」报成的 ENOENT 归一成 `is_directory`
	 * （上游 `NodeExecutionEnv` 对目录落 is_directory；调用方会按错误码分支，`not_found`
	 * 会让 `read` 工具继续走「建文件」分支把目录覆盖掉）。
	 *
	 * 只在**错误路径**多一次 stat：正常读不付这笔开销。
	 */
	async function readFileChecked(abs: string, encoding: 'utf8'): Promise<string>;
	async function readFileChecked(abs: string): Promise<Uint8Array>;
	async function readFileChecked(abs: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
		try {
			const v = encoding === 'utf8'
				? await onFs((f) => f.promises.readFile(abs, 'utf8'))
				: await onFs((f) => f.promises.readFile(abs));
			return ensureFileContent(v, abs) as string | Uint8Array;
		} catch (e) {
			if (!isNotFound(e)) throw e;
			const st = await statChecked(abs).catch(() => null);
			const isDir = st ? (st.isDirectory ? st.isDirectory() : st.type === 'dir') : false;
			if (isDir) throw new FileError('is_directory', `Is a directory: ${abs}`, abs);
			throw e;
		}
	}

	/** 父路径链上第一个「存在但不是目录」的段（路径穿过文件）；全为目录或不存在返回 undefined。
	 *  lightning-fs 对这类路径异常宽容（会把子节点挂到文件下面），必须先查。 */
	async function nonDirAncestor(abs: string): Promise<string | undefined> {
		const segs = abs.split('/').filter(Boolean);
		let cur = '';
		for (let i = 0; i < segs.length - 1; i++) {
			cur += `/${segs[i]}`;
			const st = await statChecked(cur);
			if (st) {
				const isDir = st.isDirectory ? st.isDirectory() : st.type === 'dir';
				if (!isDir) return cur;
			}
		}
		return undefined;
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

	/** `listDir` 与 `openDirReader` 共用：readdir 原序 + 逐条 stat */
	async function listEntries(abs: string): Promise<FileInfo[]> {
		const names = await onFs((f) => f.promises.readdir(abs));
		return await Promise.all(names.map((n) => statInfo(`${abs}/${n}`)));
	}

	/** 统一入口：先查 abort（上游同款，已取消的调用不产生副作用），再跑 fn，错误归一。 */
	const wrap = async <T>(path: string, context: Context, fn: () => Promise<T>): Promise<Result<T, FileError>> => {
		const aborted = abortedResult<T>(context, path);
		if (aborted) return aborted;
		try { return ok<T, FileError>(await fn()); }
		catch (e) { return err<T, FileError>(mapError(e, normalizePath(path))); }
	};

	return {
		cwd,
		// 文件命名空间 id = dbName（上游口径：equal ids see the same files at the same paths,
		// whatever their cwd —— 同库多 cwd 视图是同一个世界）
		id: dbName,
		absolutePath: async (path: string, _context: Context) => ok(normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)),
		joinPath: async (parts: string[], _context: Context) => ok(normalizePath(parts.join('/'))),

		// pi-durable 1.0.0/1.0.3 起每个方法都收 `context` 形参；`abortSignal` 做**入口检查**
		// （`abortedResult`，同上游 `abortResult`）——已取消的调用返 `aborted` 且不产生副作用。
		// 上游不查的两个纯路径计算方法（`absolutePath` / `joinPath`）也不查；`cleanup` 同样不查。
		readTextFile: (path, context) => wrap(path, context, () => readFileChecked(normalizePath(path), 'utf8')),
		readBinaryFile: (path, context) => wrap(path, context, () => readFileChecked(normalizePath(path))),
		// pi-durable 1.0.3 新增的必填契约：打开后的定位式读。`noFollow` 无从谈起（lightning-fs 无符号链接），
		// 目录按上游口径落 is_directory。整份字节在 open 时读进内存（lightning-fs 无真正的定位读原语）。
		openBinaryReader: (path, _options, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			// 先 stat 再读：lightning-fs 的 readFile 读目录报 ENOENT（会被归一成 not_found），
			// 而上游契约要目录落 is_directory
			const opened = await statInfo(abs);
			if (opened.kind === 'directory') throw new FileError('is_directory', `Is a directory: ${abs}`, abs);
			const bytes = ensureFileContent(await onFs((f) => f.promises.readFile(abs)), abs) as Uint8Array;
			return createBinaryReader(bytes, opened, abs);
		}),
		// 与上游 `NodeExecutionEnv` 同语义（0.99.1 起上游内部就是走行读取器）：结尾换行**不**产生幽灵空行、
		// 空文件返 []。旧版按 `split('\n')` 切，`"l1\nl2\n"` 会多出一行 `""`（已对齐上游）。
		// 这里不用 `wrap`：`readAllTextLines` 自己返 `Result`，套进去会变成 `Result<Result<…>>`。
		readTextLines: async (path, options, context) => {
			// 上游同款短路：maxLines <= 0 连文件都不打开（缺失路径也返 ok([])）
			if (options?.maxLines !== undefined && options.maxLines <= 0) return ok<string[], FileError>([]);
			try {
				const abs = normalizePath(path);
				const text = await readFileChecked(abs, 'utf8');
				return await readAllTextLines(createTextLineReader(text, abs), options?.maxLines, context);
			} catch (e) {
				return err<string[], FileError>(mapError(e, normalizePath(path)));
			}
		},
		// 契约（pi 0.99.1 新增）：拉取式行读取，末行 `terminated` 必须诚实（见 text-line-reader.ts）
		openTextLineReader: (path, context) => wrap(path, context, async () => {
			const text = await readFileChecked(normalizePath(path), 'utf8');
			return createTextLineReader(text, normalizePath(path));
		}),
		writeFile: (path, content, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			// 路径穿过文件：上游报 ENOTDIR；lightning-fs 会把子节点挂到文件下面
			const badParent = await nonDirAncestor(abs);
			if (badParent) throw new FileError('not_directory', `Not a directory: ${badParent}`, badParent);
			await mkdirp(abs.split('/').slice(0, -1).join('/'));
			await onFs((f) => f.promises.writeFile(abs, content));
		}),
		// lightning-fs 无 appendFile：读旧内容拼接（会话 JSONL 追加走这里，文件不大）
		appendFile: (path, content, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			// 路径穿过文件：上游报 ENOTDIR
			const badParent = await nonDirAncestor(abs);
			if (badParent) throw new FileError('not_directory', `Not a directory: ${badParent}`, badParent);
			await mkdirp(abs.split('/').slice(0, -1).join('/'));
			let prev = '';
			try { prev = (await onFs((f) => f.promises.readFile(abs, 'utf8'))) ?? ''; } catch (e) { if (!isNotFound(e)) throw e; }
			const next = typeof content === 'string' ? content : new TextDecoder().decode(content);
			await onFs((f) => f.promises.writeFile(abs, prev + next));
		}),
		renameFile: (src, dest, context) => wrap(src, context, async () => {
			const from = normalizePath(src);
			const to = normalizePath(dest);
			// 自我 rename：lightning-fs 是先 set 再 unlink 同一个 key ⇒ 静默删文件。上游 fs.rename 是成功 no-op
			if (from === to) return;
			// 根不可改名（上游 EBUSY）
			if (from === '/') throw new FileError('unknown', 'Cannot rename the root directory', from);
			// 类型冲突：rename 到已存在目录（上游 EISDIR），lightning-fs 会静默覆盖
			const target = await statChecked(to);
			const targetIsDir = target ? (target.isDirectory ? target.isDirectory() : target.type === 'dir') : false;
			if (targetIsDir) throw new FileError('is_directory', `Is a directory: ${to}`, to);
			// 目录 rename 到已存在文件：上游 ENOTDIR，不能把文件静默换成目录
			const sourceInfo = await statChecked(from);
			const sourceIsDir = sourceInfo ? (sourceInfo.isDirectory ? sourceInfo.isDirectory() : sourceInfo.type === 'dir') : false;
			if (sourceIsDir && target) throw new FileError('not_directory', `Not a directory: ${to}`, to);
			// 路径穿过文件：上游 ENOTDIR。不查时 mkdirp 会吞掉 EEXIST，再把子节点挂到文件下面
			const badParent = await nonDirAncestor(to);
			if (badParent) throw new FileError('not_directory', `Not a directory: ${badParent}`, badParent);
			await mkdirp(to.split('/').slice(0, -1).join('/'));
			await onFs((f) => f.promises.rename(from, to));
		}),
		fileInfo: (path, context) => wrap(path, context, () => statInfo(path)),
		listDir: (path, context) => wrap(path, context, () => listEntries(normalizePath(path))),
		// pi-durable 1.0.3 新增的必填契约：目录分页。条目在 open 时列一次（见 pull-readers.ts 的快照取舍）
		openDirReader: (path, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			return createDirReader(await listEntries(abs), abs);
		}),
		// lightning-fs 无符号链接：归一化即规范路径；仍照上游查 abort 与存在性（上游 realpath 报 ENOENT）
		canonicalPath: async (path: string, context: Context) => {
			const aborted = abortedResult<string>(context, path);
			if (aborted) return aborted;
			const abs = normalizePath(path);
			return (await statChecked(abs)) === null
				? err<string, FileError>(new FileError('not_found', `Not found: ${abs}`, abs))
				: ok(abs);
		},
		// pi 契约：缺失路径返 false；权限类失败才返 FileError（lightning-fs 无权限概念 → 基本只有 false 分支）
		exists: (path, context) => wrap(path, context, async () => (await statChecked(normalizePath(path))) !== null),
		createDir: (path, options, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			// 路径穿过文件：上游报 ENOTDIR
			const badParent = await nonDirAncestor(abs);
			if (badParent) throw new FileError('not_directory', `Not a directory: ${badParent}`, badParent);
			// 类型冲突：已存在的**文件**不能被静默替换成目录（上游 EEXIST；spec §3 禁止对齐 unknown → invalid）
			const existing = await statChecked(abs);
			if (existing && !(existing.isDirectory ? existing.isDirectory() : existing.type === 'dir')) {
				throw new FileError('invalid', `Already exists: ${abs}`, abs);
			}
			if (options?.recursive === false) await onFs((f) => f.promises.mkdir(abs));
			else await mkdirp(abs);
		}),
		remove: (path, options, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			// 删根之后整棵树都没了（上游 EBUSY）；与 memory 后端 / wasi-fs.rmdirSync 同一道闸
			if (abs === '/') throw new FileError('unknown', 'Cannot remove the root directory', abs);
			// 路径穿过文件：上游报 ENOTDIR（不能当成「不存在」静默成功）
			const badParent = await nonDirAncestor(abs);
			if (badParent) throw new FileError('not_directory', `Not a directory: ${badParent}`, badParent);
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
		createTempDir: (prefix, context) => wrap('/', context, async () => {
			const dir = `/tmp/${prefix ?? 'tmp-'}${Math.random().toString(36).slice(2, 10)}`;
			await mkdirp(dir);
			return dir;
		}),
		createTempFile: (options, context) => wrap('/', context, async () => {
			const file = `/tmp/${options?.prefix ?? ''}${Math.random().toString(36).slice(2, 10)}${options?.suffix ?? ''}`;
			await mkdirp('/tmp');
			await onFs((f) => f.promises.writeFile(file, ''));
			return file;
		}),
		// lightning-fs 无 close；实例生命周期由调用方（web 端单例）持有
		// pi 1.0.0 新增。lightning-fs **没有** truncate 原语（实测 grep 无此方法），所以走读-改-写。
		// `size` 校验与上游 NodeExecutionEnv 同款；缺文件由 readFile 的 ENOENT 归一为 not_found。
		// 同内存后端：这是**立即分配**（`new Uint8Array(size)`），上游 ftruncate 是稀疏扩。
		truncateFile: (path, size, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			if (!Number.isSafeInteger(size) || size < 0) {
				throw new FileError('invalid', 'File size must be a non-negative safe integer', abs);
			}
			const bytes = await readFileChecked(abs);   // 目录在这里落 is_directory
			const next = new Uint8Array(size);
			next.set(bytes.subarray(0, Math.min(size, bytes.length)));
			await onFs((f) => f.promises.writeFile(abs, next));
		}),
		// pi 1.0.0 新增：lightning-fs 没有 per-file flush，如实降级为**整体落盘**
		// （与自有 BrowserFileSystem.flush() 同一条路径）。存在性照上游先开 r+。
		flushFile: (path, context) => wrap(path, context, async () => {
			const abs = normalizePath(path);
			const st = await statChecked(abs);
			if (st === null) throw new FileError('not_found', `Not found: ${abs}`, abs);
			if (st.isDirectory ? st.isDirectory() : st.type === 'dir') {
				throw new FileError('is_directory', `Is a directory: ${abs}`, abs);
			}
			await onFs((f) => f.promises.flush());
		}),
		cleanup: async (_context: Context) => { /* 无资源需释放 */ },
		// pi-durable 1.0.3 新增的必填契约：浏览器没有 fs 事件源（lightning-fs 也不提供），
		// **如实答不支持**，不假装返回「永不变化的 watcher」（那会让调用方一直等不到覆盖建立）。
		// 仍照上游先查 abort：已取消的调用不该开始建 watcher。
		watch: async (targets, _onChange, context) =>
			abortedResult<FileWatcher>(context) ?? err(new FileError('not_supported', `浏览器 fs 不支持 watch: ${targets.map((t) => t.path).join(', ')}`)),
		// 强制把超级块（目录树）写入 IDB，绕开 lightning-fs 的 500ms debounce（见 BrowserFileSystem.flush）
		flush: async () => { await onFs((f) => f.promises.flush()); },
	};
}
