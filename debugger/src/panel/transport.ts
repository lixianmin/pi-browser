// debugger/src/panel/transport.ts —— 面板侧:runtime 消息 → background(spec §3)。
// chrome 在调用时才解引用,便于测试 stubGlobal。onNavigated → 页面刷新后重装 bridge 的信号源。
import type { FsOp, OpResult } from '../shared/protocol';

export function getTabId(): number {
	return chrome.devtools.inspectedWindow.tabId;
}

export async function callOp(op: FsOp, dbName: string | null): Promise<OpResult> {
	let r: unknown;
	try {
		r = await chrome.runtime.sendMessage({
			type: 'pi-debugger-call',
			tabId: getTabId(),
			dbName,
			op,
		});
	} catch (e) {
		// 扩展被 reload 后旧 panel 的 context 失效：sendMessage reject。不能让它变成 unhandled rejection
		// 把面板卡在「未加载」。
		return { ok: false, error: { code: 'bridge_unreachable', message: (e as Error)?.message ?? String(e) } };
	}
	if (!r || typeof r !== 'object' || !('ok' in r)) {
		return { ok: false, error: { code: 'bridge_unreachable', message: 'empty response from background' } };
	}
	return r as OpResult;
}

/** 注册导航监听；返回退订函数（切换 DB 会重建闭包，不退订会累积并让旧库的响应覆盖新树） */
export function onNavigated(cb: () => void): () => void {
	chrome.devtools.network.onNavigated.addListener(cb);
	return () => chrome.devtools.network.onNavigated.removeListener(cb);
}
