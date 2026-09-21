// debugger/src/background/inject.ts —— chrome.scripting.executeScript 的两个原语(spec §3)。
// func 注入的函数体只允许引用 window 全局(F2:序列化后闭包丢失),bridge 以
// window.__piBrowserDebugger 常驻,func 只是薄调用。async func 的 Promise 由
// Chrome await(F1),所以面板侧拿到的一定是 settle 后的 OpResult。
import { PI_BRIDGE_VERSION } from '../bridge/install';
import type { FsOp, OpResult } from '../shared/protocol';

export { PI_BRIDGE_VERSION };

export interface ScriptingLike {
	executeScript(injection: {
		target: { tabId: number };
		world?: string;
		files?: string[];
		func?: (...args: never[]) => unknown;
		args?: unknown[];
	}): Promise<{ result?: unknown }[]>;
}

/** 确保 bridge 常驻且版本匹配;缺失/过期时以 files 注入重装(bridge 自身幂等) */
export async function ensureBridge(scripting: ScriptingLike, tabId: number, expected = PI_BRIDGE_VERSION): Promise<void> {
	const [probe] = await scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: () => (window as unknown as { __piBrowserDebugger?: { version: number } }).__piBrowserDebugger?.version ?? null,
	});
	if (probe.result !== expected) {
		await scripting.executeScript({
			target: { tabId },
			world: 'MAIN',
			files: ['bridge.js'],
		});
	}
}

export async function callBridge(scripting: ScriptingLike, tabId: number, dbName: string, op: FsOp): Promise<OpResult> {
	const [r] = await scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: (dbName: string, op: FsOp) => window.__piBrowserDebugger!.call(dbName, op),
		args: [dbName, op],
	});
	return r.result as OpResult;
}
