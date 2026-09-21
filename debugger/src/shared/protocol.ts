// debugger/src/shared/protocol.ts —— 面板 ↔ bridge 的 op 协议(spec §6)。
// 硬约束:所有值跨 executeScript args/result 与 chrome.runtime 消息两层 JSON 边界,
// 因此只用 string/number/boolean/null/数组/纯对象;二进制一律 base64。

/** 宿主默认 IDB 库名(与主包 createBrowserFileSystem 默认值一致) */
export const DEFAULT_DB = 'spice-sessions';

/** 文本预览截断阈值 200KB(spec §6) */
export const DEFAULT_MAX_BYTES = 200 * 1024;

export type FsOp =
	| { kind: 'databases' }
	| { kind: 'list'; path: string }
	| { kind: 'read'; path: string; maxBytes?: number }
	| { kind: 'write'; path: string; content: string; encoding?: 'text' | 'base64' }
	| { kind: 'delete'; path: string; recursive?: boolean }
	| { kind: 'mkdir'; path: string }
	| { kind: 'rename'; from: string; to: string }
	| { kind: 'stat'; path: string };

/** 错误 code 沿主包 FileError 语义(backend-idb.ts 的映射表),外加 bridge 不可达 */
export interface OpError {
	code: string;
	message: string;
}

export interface ListEntry {
	name: string;
	path: string;
	kind: 'file' | 'directory';
	size: number;
}

export type OpValue =
	| { kind: 'databases'; names: string[] }
	| { kind: 'list'; entries: ListEntry[] }
	| { kind: 'read'; encoding: 'text'; content: string; truncated: boolean; totalBytes: number }
	| { kind: 'read'; encoding: 'base64'; content: string; totalBytes: number }
	| { kind: 'write'; bytes: number }
	| { kind: 'delete' }
	| { kind: 'mkdir' }
	| { kind: 'rename' }
	| { kind: 'stat'; entry: ListEntry };

export type OpResult = { ok: true; value: OpValue } | { ok: false; error: OpError };

/** Uint8Array → base64。分块防 String.fromCharCode 爆栈(65536 是保守块长)。 */
export function bytesToBase64(bytes: Uint8Array): string {
	let out = '';
	const CHUNK = 1 << 16; // 65536:String.fromCharCode 变参的安全上限
	for (let i = 0; i < bytes.length; i += CHUNK) {
		out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(out);
}

/** base64 → Uint8Array(atob 出的是 latin1 串,逐字符取码点即原字节) */
export function base64ToBytes(b64: string): Uint8Array {
	const raw = atob(b64);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}
