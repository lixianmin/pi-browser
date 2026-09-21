// src/shell/host-commands/defaults.ts —— pi-browser 默认携带的宿主命令。
//
// 为什么默认携带而不是让消费者自己注册：这些是「wasi-sh 的 busybox 在这个执行环境里做不到、
// 但 agent 生成脚本时会理所当然地用」的命令（实测：spec 的脚本用 which/mount 探测环境，
// busybox 的 which 找不到 applet、mount 根本不存在）。让每个消费者各撞一遍再各自修，是重复浪费。
//
// 消费者仍可覆盖：createBrowserExecutionEnv 里 `{ ...默认, ...调用方给的 }`，同名以调用方为准。
import type { HostCommandRegistry } from '../host-commands';
import { makeMount } from './mount';
import { makeWhich } from './which';

/**
 * @param resolvable shell 能自行解析的名字（applet + ash 内建 + 已注册的宿主命令），供 `which` 判定。
 */
export function createDefaultHostCommands(resolvable: ReadonlySet<string>): HostCommandRegistry {
	return {
		which: makeWhich(resolvable),
		mount: makeMount(),
	};
}
