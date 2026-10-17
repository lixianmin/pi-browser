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
	// 非可写属性：普通赋值挡不住页面脚本把 call 换成自己的实现（或把整个对象换掉），
	// defineProperty 至少让安装后的实例不能被事后改写。configurable 保持 true，版本换代时可替换。
	Object.defineProperty(window, '__piBrowserDebugger', {
		value: { version: PI_BRIDGE_VERSION, call: (db: string, op: FsOp) => handleOp(db, op) },
		writable: false,
		configurable: true,
		enumerable: true,
	});
	return existing ? 'replaced' : 'installed';
}
