// debugger/src/bridge/handler.ts —— 在被检查页面 main world 里执行 fs op 的核心。
// 与宿主共用同一 IDB 库(同 dbName 的 lightning-fs 实例,Web Locks 互斥),
// 写操作后必须 flush(spec §6:lightning-fs 超级块 500ms debounce,不 flush 会丢路径)。
// 纯函数化:不碰 chrome.* / window,page world 与 node 测试(fake-indexeddb)共用。
import { BACKGROUND_CONTEXT, FileError, type FileInfo } from '@earendil-works/pi-agent-core';
import { createBrowserFileSystem, normalizePath, type BrowserFileSystem } from '@lixianmin/pi-browser';
import {
	DEFAULT_DB,
	DEFAULT_MAX_BYTES,
	base64ToBytes,
	bytesToBase64,
	type FsOp,
	type ListEntry,
	type OpError,
	type OpResult,
} from '../shared/protocol';

const CTX = BACKGROUND_CONTEXT;

/** dbName → fs 实例表:一个库只开一个实例（pi-browser 内核注册表同 dbName 同世界，此处表只省重复建对象） */
const open = new Map<string, Promise<BrowserFileSystem>>();

function getFs(dbName: string): Promise<BrowserFileSystem> {
	let p = open.get(dbName);
	if (!p) {
		p = Promise.resolve(createBrowserFileSystem({ dbName, memory: false }));
		open.set(dbName, p);
	}
	return p;
}

/** 测试隔离:清实例表(lightning-fs 模块级实例按库名缓存,跨用例需要重开) */
export function resetHandlerCache(): void {
	open.clear();
}

function toOpError(e: unknown): OpError {
	const code = e instanceof FileError ? e.code : String((e as { code?: string })?.code ?? 'unknown');
	// lightning-fs 抛 errno 风格错误;主包 backend 已归一为 FileError.code,这里兜底映射
	const normalized = normalizeErrno(code);
	return { code: normalized, message: (e as Error)?.message ?? String(e) };
}

function normalizeErrno(code: string): string {
	switch (code) {
		case 'ENOENT': return 'not_found';
		case 'ENOTDIR': return 'not_directory';
		case 'EISDIR': return 'is_directory';
		case 'EACCES':
		case 'EPERM': return 'permission_denied';
		case 'EEXIST': return 'already_exists';
		default: return code || 'unknown';
	}
}

function toEntry(info: FileInfo): ListEntry {
	return {
		name: info.name,
		path: info.path,
		kind: info.kind === 'directory' ? 'directory' : 'file',
		size: info.size,
	};
}

/** 探测二进制:首块出现 NUL 字节即视为二进制(文本协议场景足够;spec §6) */
function looksBinary(bytes: Uint8Array): boolean {
	const probe = bytes.subarray(0, 8192);
	for (let i = 0; i < probe.length; i++) {
		if (probe[i] === 0) return true;
	}
	return false;
}

export async function handleOp(dbName: string, op: FsOp): Promise<OpResult> {
	try {
		switch (op.kind) {
			case 'databases': {
				const dbs = await indexedDB.databases();
				const names = dbs
					.map((d) => d.name)
					.filter((n): n is string => typeof n === 'string')
					.sort();
				return { ok: true, value: { kind: 'databases', names } };
			}
			case 'list': {
				const fs = await getFs(dbName || DEFAULT_DB);
				const r = await fs.listDir(normalizePath(op.path), CTX);
				if (!r.ok) throw r.error;
				return { ok: true, value: { kind: 'list', entries: r.value.map(toEntry) } };
			}
			case 'read': {
				const fs = await getFs(dbName || DEFAULT_DB);
				const maxBytes = op.maxBytes ?? DEFAULT_MAX_BYTES;
				const path = normalizePath(op.path);
				const r = await fs.readBinaryFile(path, CTX);
				if (!r.ok) throw r.error;
				const bytes = r.value;
				if (looksBinary(bytes)) {
					return { ok: true, value: { kind: 'read', encoding: 'base64', content: bytesToBase64(bytes), totalBytes: bytes.length } };
				}
				const truncated = bytes.length > maxBytes;
				const text = new TextDecoder().decode(truncated ? bytes.subarray(0, maxBytes) : bytes);
				return { ok: true, value: { kind: 'read', encoding: 'text', content: text, truncated, totalBytes: bytes.length } };
			}
			case 'write': {
				const fs = await getFs(dbName || DEFAULT_DB);
				const path = normalizePath(op.path);
				const content = op.encoding === 'base64' ? base64ToBytes(op.content) : op.content;
				const r = await fs.writeFile(path, content, CTX);
				if (!r.ok) throw r.error;
				await fs.flush();
				return { ok: true, value: { kind: 'write', bytes: typeof content === 'string' ? new TextEncoder().encode(content).length : content.length } };
			}
			case 'delete': {
				const fs = await getFs(dbName || DEFAULT_DB);
				const r = await fs.remove(normalizePath(op.path), { recursive: op.recursive ?? false, force: false }, CTX);
				if (!r.ok) throw r.error;
				await fs.flush();
				return { ok: true, value: { kind: 'delete' } };
			}
			case 'mkdir': {
				const fs = await getFs(dbName || DEFAULT_DB);
				const r = await fs.createDir(normalizePath(op.path), { recursive: true }, CTX);
				if (!r.ok) throw r.error;
				await fs.flush();
				return { ok: true, value: { kind: 'mkdir' } };
			}
			case 'rename': {
				const fs = await getFs(dbName || DEFAULT_DB);
				const r = await fs.renameFile(normalizePath(op.from), normalizePath(op.to), CTX);
				if (!r.ok) throw r.error;
				await fs.flush();
				return { ok: true, value: { kind: 'rename' } };
			}
			case 'stat': {
				const fs = await getFs(dbName || DEFAULT_DB);
				const r = await fs.fileInfo(normalizePath(op.path), CTX);
				if (!r.ok) throw r.error;
				return { ok: true, value: { kind: 'stat', entry: toEntry(r.value) } };
			}
		}
	} catch (e) {
		return { ok: false, error: toOpError(e) };
	}
}
