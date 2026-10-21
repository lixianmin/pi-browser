import { makeMount } from './mount.js';
import { makeWhich } from './which.js';
/**
 * @param resolvable shell 能自行解析的名字（applet + ash 内建 + 已注册的宿主命令），供 `which` 判定。
 */
export function createDefaultHostCommands(resolvable) {
    // 默认命令自己也是「shell 可解析的名字」：只把调用方给的集合传下去，`which which` / `which mount`
    // 会掉进 PATH 查找而报 exit 1（它们不在 RESERVED_COMMAND_NAMES 里——那是 applet/内建名单）。
    const selfResolvable = new Set([...resolvable, 'which', 'mount']);
    return {
        which: makeWhich(selfResolvable),
        mount: makeMount(),
    };
}
