// debugger/src/background/router.ts —— chrome.runtime.onMessage 的路由决策(纯逻辑,可测)。
// 为什么存在 background:DevTools 上下文的扩展 API 是白名单制,panel 不赌
// chrome.scripting 直通性;panel→runtime 消息→background 执行注入是官方背书模式(spec §3)。
import { callBridge, ensureBridge, type ScriptingLike } from './inject';
import type { FsOp, OpResult } from '../shared/protocol';

export interface RouterDeps {
	ensureBridge(tabId: number): Promise<void>;
	callBridge(tabId: number, dbName: string, op: FsOp): Promise<OpResult>;
}

export type RuntimeMessage = {
	type: 'pi-debugger-call';
	tabId: number;
	dbName: string | null;
	op: FsOp;
};

/**
 * 返回 onMessage listener:只接管 `pi-debugger-call`;async 完成前保持消息通道
 * (返回 true);任何异常都结构化为 bridge_unreachable,面板侧永远拿得到应答。
 */
export function createMessageHandler(deps: RouterDeps) {
	return (
		msg: unknown,
		_sender: unknown,
		sendResponse: (response: OpResult) => void,
	): boolean => {
		const m = msg as RuntimeMessage | { type?: string };
		if (m?.type !== 'pi-debugger-call') return false;
		const { tabId, dbName, op } = m as RuntimeMessage;
		void (async () => {
			try {
				await deps.ensureBridge(tabId);
				sendResponse(await deps.callBridge(tabId, dbName ?? 'spice-sessions', op));
			} catch (e) {
				sendResponse({
					ok: false,
					error: { code: 'bridge_unreachable', message: (e as Error)?.message ?? String(e) },
				});
			}
		})();
		return true;
	};
}

/** chrome 接线用:真实依赖组装(spec:DEFAULT_DB 在 router 内兜底) */
export function chromeRouter(scripting: ScriptingLike): RouterDeps {
	return {
		ensureBridge: (tabId) => ensureBridge(scripting, tabId),
		callBridge: (tabId, dbName, op) => callBridge(scripting, tabId, dbName, op),
	};
}
