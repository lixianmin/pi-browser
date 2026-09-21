// debugger/src/bridge/install.ts —— bridge 在页面 main world 的常驻安装点。
// executeScript files 注入会整体重新执行本模块;幂等性靠 window 上的版本号:
// 同版本 → 不动(保持既有实例);旧版本/缺失 → 重建。spec §3。
import { handleOp } from './handler';
import type { FsOp, OpResult } from '../shared/protocol';

export const PI_BRIDGE_VERSION = 1;

export interface PiBridge {
	version: number;
	call(dbName: string, op: FsOp): Promise<OpResult>;
}

declare global {
	interface Window {
		__piBrowserDebugger?: PiBridge;
	}
}

export type InstallOutcome = 'installed' | 'replaced' | 'current';

export function installBridge(): InstallOutcome {
	const existing = window.__piBrowserDebugger;
	if (existing?.version === PI_BRIDGE_VERSION) return 'current';
	window.__piBrowserDebugger = { version: PI_BRIDGE_VERSION, call: (db, op) => handleOp(db, op) };
	return existing ? 'replaced' : 'installed';
}
