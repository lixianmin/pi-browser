// debugger/test/protocol.test.ts —— 协议层:JSON 边界两次往返(executeScript args/result
// + runtime message)后必须逐字不变。这是 spec「Review Focus」第 2 条的钉子。
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_DB,
	DEFAULT_MAX_BYTES,
	base64ToBytes,
	bytesToBase64,
	type FsOp,
	type OpResult,
} from '../src/shared/protocol';

const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe('protocol', () => {
	it('DEFAULT_DB / DEFAULT_MAX_BYTES 与 spec §6 一致', () => {
		expect(DEFAULT_DB).toBe('spice-sessions');
		expect(DEFAULT_MAX_BYTES).toBe(200 * 1024);
	});

	it('所有 FsOp variant 可 JSON 往返', () => {
		const ops: FsOp[] = [
			{ kind: 'databases' },
			{ kind: 'list', path: '/s1' },
			{ kind: 'read', path: '/s1/main.jsonl', maxBytes: 1024 },
			{ kind: 'write', path: '/a.txt', content: 'hi', encoding: 'text' },
			{ kind: 'write', path: '/a.bin', content: 'aGk=', encoding: 'base64' },
			{ kind: 'delete', path: '/tmp', recursive: true },
			{ kind: 'mkdir', path: '/new/dir' },
			{ kind: 'rename', from: '/a.txt', to: '/b.txt' },
			{ kind: 'stat', path: '/a.txt' },
		];
		for (const op of ops) expect(roundTrip(op)).toEqual(op);
	});

	it('OpResult 成功/失败形态可 JSON 往返', () => {
		const ok: OpResult = {
			ok: true,
			value: {
				kind: 'list',
				entries: [{ name: 'main.jsonl', path: '/s1/main.jsonl', kind: 'file', size: 3 }],
			},
		};
		const err: OpResult = { ok: false, error: { code: 'not_found', message: 'Not found: /x' } };
		expect(roundTrip(ok)).toEqual(ok);
		expect(roundTrip(err)).toEqual(err);
	});

	it('base64 往返:含 0x00 与 >0x7F 字节', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 255, 0, 254]);
		const b64 = bytesToBase64(bytes);
		expect(typeof b64).toBe('string');
		expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
	});

	it('base64 往返:多字节 UTF-8 文本字节', () => {
		const bytes = new TextEncoder().encode('héllo 世界 🎉');
		expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
	});

	it('base64:空数组往返为空', () => {
		expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toHaveLength(0);
	});
});
