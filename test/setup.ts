// Web Locks shim：LightningFS 的 DefaultBackend 需要 navigator.locks（Mutex2 分支），
// 缺失时回退 Mutex（idb-keyval → 需要 indexedDB）——无 shim 的 Node 上首操作必抛
// `indexedDB is not defined`。这里注入单进程「申请即授予」的假锁，消掉 Node 版本耦合
// （先例：spice apps/web/test/setup.ts）。只在缺失时注入，有 locks 的环境是 no-op。
if (typeof navigator === 'undefined' || !(navigator as { locks?: unknown }).locks) {
	const g = globalThis as { navigator?: { locks?: unknown } };
	g.navigator ??= {} as Navigator;
	(g.navigator as { locks: unknown }).locks = {
		// 契约（对照 lightning-fs/src/Mutex2.js）：request(name, {ifAvailable}/{signal}, fn) 或 (name, fn)；
		// fn 收到锁对象（申请不到时是 null）——必须传对象，它的 `!!lock` 决定 mutex.has()；
		// 返回的 Promise 一直持有锁直到 release() 解析。单进程测试无需真互斥，授予即真。
		request: async (name: string, a: unknown, b?: unknown) => {
			const fn = (typeof a === 'function' ? a : b) as (lock: unknown) => Promise<unknown>;
			return fn({ name });
		},
	};
}
