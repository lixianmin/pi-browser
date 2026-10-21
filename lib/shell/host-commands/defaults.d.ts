import type { HostCommandRegistry } from '../host-commands.js';
/**
 * @param resolvable shell 能自行解析的名字（applet + ash 内建 + 已注册的宿主命令），供 `which` 判定。
 */
export declare function createDefaultHostCommands(resolvable: ReadonlySet<string>): HostCommandRegistry;
