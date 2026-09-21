// src/shell/host-commands/mount.ts —— 默认宿主命令：`mount`。
//
// busybox 的 mount（CONFIG_MOUNT）在 wasi-sh 里没有意义：它要么调真实 mount syscall，
// 要么读 /proc/mounts 或 /etc/mtab——wasi 里三样都没有，开了也是哑炮。
//
// 这里给的是「无参 mount」的语义：列出挂载表。数据来自宿主注入的 request.mounts
//（worker 路径的 createHostCommandResponder 从 store.mounts 填进来），输出形如
//   / on browser-fs
//   /tmp on browser-fs
// 真实后端类型（IDB / 内存）不在 MountEntry 里，不编造。
import type { HostCommandHandler } from '../host-commands';

export function makeMount(): HostCommandHandler {
	return (request) => {
		const mounts = request.mounts ?? [];
		if (mounts.length === 0) {
			// inline 路径没有挂载表可读（没有 store）——明确报错，不假装成功
			return { exitCode: 1, stderr: 'mount: 无挂载表可用（该命令只在 worker 路径可读）\n' };
		}
		return {
			exitCode: 0,
			stdout: `${mounts.map((m) => `${m.prefix} on browser-fs`).join('\n')}\n`,
		};
	};
}
