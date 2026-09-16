// src/env/mount.ts —— 挂载表路由：路径前缀 → 后端 fs（spec §3）。
//
// 顺序钉死：**先 `normalizePath` 归一，再按「路径段边界 + 最长前缀」分派**。否则 `..` 会穿 mount
// （`/tmp/../a` 落进 /tmp 后端），且 `startsWith('/tmp')` 会把 `/tmpfoo` 静默路由进内存挂载——
// 那是刷新即丢数据的一类 bug。另：`createTempDir/createTempFile` 固定投 `/tmp` 挂载（后端不感知自身
// 前缀，顺其自然按入参分派就会写出「内容在 IDB、路径读走内存」的 split-brain）。
//
// 路由只做分派，不搞插件框架（AGENTS §2）：表内三个内建 backend 之上不加抽象。
import { FileError, ok, err, type FileInfo, type FileSystem, type Result } from '@earendil-works/pi-agent-core';
import { normalizePath } from './path';
import type { BrowserFileSystem } from './types';

export interface MountEntry {
	/** 挂载前缀（绝对路径，如 '/'、'/tmp'） */
	prefix: string;
	fs: BrowserFileSystem;
}

export interface MountTable extends FileSystem {
	/** 挂载顶层名（'/tmp' → 'tmp'；'/' 不入列），供 `listDir('/')` 合成挂载根 */
	roots(): string[];
}

const basename = (p: string): string => normalizePath(p).split('/').filter(Boolean).pop() ?? '';

export function createMountTable(entries: MountEntry[]): MountTable {
	// 前缀按长度降序 = 最长前缀优先；sort 稳定，同长时保持注册顺序（'/' 兜底在上时也安全）
	const mounts = entries
		.map((e) => ({ prefix: normalizePath(e.prefix), fs: e.fs }))
		.sort((a, b) => b.prefix.length - a.prefix.length);
	const cwd = entries[0]?.fs.cwd ?? '/';
	/** 相对路径按表的 cwd 解析；所有委托都传**绝对**路径，后端各自的 cwd 不参与（避免两份 cwd 漂移） */
	const abs = (path: string) => normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`);
	const mountFor = (p: string) => mounts.find((m) => m.prefix === '/' || p === m.prefix || p.startsWith(`${m.prefix}/`));
	/** 挂载点本身（非 '/'）——存在性由表应答，不打到后端 */
	const isMountRoot = (p: string) => mounts.some((m) => m.prefix !== '/' && m.prefix === p);
	const parentOf = (p: string) => normalizePath(p).split('/').slice(0, -1).join('/') || '/';
	/** parent 的直属挂载点顶层名（挂载根目录视图的合成来源） */
	const childMountNames = (parent: string): string[] =>
		mounts.filter((m) => m.prefix !== '/' && parentOf(m.prefix) === parent).map((m) => basename(m.prefix));
	const dirInfo = (p: string): FileInfo => ({ name: basename(p), path: p, kind: 'directory', size: 0, mtimeMs: 0 });

	/** 分派 + 委托：无挂载点匹配（表里连 '/' 都没有）时返回 not_supported，不抛（pi 契约：方法不抛） */
	async function delegate<T>(path: string, fn: (fs: BrowserFileSystem, absPath: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		const absPath = abs(path);
		const mount = mountFor(absPath);
		if (!mount) return err<T, FileError>(new FileError('not_supported', `无挂载点覆盖: ${absPath}`, absPath));
		return await fn(mount.fs, absPath);
	}

	return {
		cwd,
		absolutePath: async (path) => ok(normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)),
		joinPath: async (parts) => ok(normalizePath(parts.join('/'))),
		canonicalPath: (path, context) => delegate(path, (fs, p) => fs.canonicalPath(p, context)),
		readTextFile: (path, context) => delegate(path, (fs, p) => fs.readTextFile(p, context)),
		readTextLines: (path, options, context) => delegate(path, (fs, p) => fs.readTextLines(p, options, context)),
		readBinaryFile: (path, context) => delegate(path, (fs, p) => fs.readBinaryFile(p, context)),
		writeFile: (path, content, context) => delegate(path, (fs, p) => fs.writeFile(p, content, context)),
		appendFile: (path, content, context) => delegate(path, (fs, p) => fs.appendFile(p, content, context)),
		createDir: (path, options, context) => delegate(path, (fs, p) => fs.createDir(p, options, context)),
		remove: (path, options, context) => delegate(path, (fs, p) => fs.remove(p, options, context)),
		renameFile: async (sourcePath, destinationPath, context) => {
			const from = abs(sourcePath);
			const to = abs(destinationPath);
			const fromMount = mountFor(from);
			// 跨挂载点 rename 是浏览器侧有意分叉：上游契约本就写「不跨文件系统」，Node 同场景落 unknown
			// （toFileError 没有 not_supported 分支）——这里落 not_supported，别把 Node 的 unknown 对齐过来。
			if (!fromMount || fromMount !== mountFor(to)) {
				return err<void, FileError>(new FileError('not_supported', `跨挂载点重命名不被支持: ${from} → ${to}`, from));
			}
			return await fromMount.fs.renameFile(from, to, context);
		},
		fileInfo: async (path, context) => {
			const p = abs(path);
			if (isMountRoot(p)) return ok(dirInfo(p));
			return await delegate(path, (fs, q) => fs.fileInfo(q, context));
		},
		exists: async (path, context) => {
			const p = abs(path);
			if (isMountRoot(p)) return ok(true);
			return await delegate(path, (fs, q) => fs.exists(q, context));
		},
		listDir: async (path, context) => {
			const p = abs(path);
			// 目录视图只在 '/' 或挂载前缀处合成（挂载点的存在性不依赖后端）。更深的挂载点若其祖先
			// 不是挂载前缀则无合成——默认表（'/' + '/tmp'）无此形状，不预造递归逻辑。
			if (p !== '/' && !isMountRoot(p)) return await delegate(path, (fs, q) => fs.listDir(q, context));
			const mount = mountFor(p);
			const listed = mount ? await mount.fs.listDir(p, context) : undefined;
			// 空挂载点（后端里没这个目录）不算失败：挂载根由表应答；'/' 的失败照传（不是挂载根语义）
			if (listed && !listed.ok && !(isMountRoot(p) && listed.error.code === 'not_found')) return listed;
			const own = listed?.ok ? listed.value : [];
			const synth = childMountNames(p).map((n) => dirInfo(`${p === '/' ? '' : p}/${n}`));
			const merged = [...own, ...synth.filter((s) => !own.some((i) => i.name === s.name))];
			// 根/挂载根的合并视图排序：两个来源（后端 + 合成）无共同顺序，排序给确定结果
			return ok(merged.sort((a, b) => a.name.localeCompare(b.name)));
		},
		// 临时件固定投 '/tmp' 挂载（不按入参路径分派）：否则写进 '/' 后端、读走 /tmp 后端
		createTempDir: (prefix, context) => delegate('/tmp', (fs) => fs.createTempDir(prefix, context)),
		createTempFile: (options, context) => delegate('/tmp', (fs) => fs.createTempFile(options, context)),
		// 上游契约：cleanup 必须 best-effort、不抛；一个后端失败不阻断其余（同一后端去重，避免重复释放）
		cleanup: async (context) => {
			for (const fs of new Set(mounts.map((m) => m.fs))) {
				try { await fs.cleanup(context); } catch { /* best-effort */ }
			}
		},
		roots: () => childMountNames('/'),
	};
}
