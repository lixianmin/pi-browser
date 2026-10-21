import type { HostCommandHandler } from '../host-commands.js';
/** resolvable = shell 能自行解析的名字（applet + ash 内建 + 已注册宿主命令），见 RESERVED_COMMAND_NAMES */
export declare function makeWhich(resolvable: ReadonlySet<string>): HostCommandHandler;
