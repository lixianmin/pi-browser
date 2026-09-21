// debugger/src/panel/transport.ts —— 面板侧:runtime 消息 → background(spec §3)。
// chrome 在调用时才解引用,便于测试 stubGlobal。onNavigated → 页面刷新后重装 bridge 的信号源。
import type { FsOp, OpResult } from '../shared/protocol';

export function getTabId(): number {
	return chrome.devtools.inspectedWindow.tabId;
}

export async function callOp(op: FsOp, dbName: string | null): Promise<OpResult> {
	const r = (await chrome.runtime.sendMessage({
		type: 'pi-debugger-call',
		tabId: getTabId(),
		dbName,
		op,
	})) as unknown;
	if (!r || typeof r !== 'object' || !('ok' in r)) {
		return { ok: false, error: { code: 'bridge_unreachable', message: 'empty response from background' } };
	}
	return r as OpResult;
}

export function onNavigated(cb: () => void): void {
	chrome.devtools.network.onNavigated.addListener(cb);
}
