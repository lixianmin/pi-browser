// src/shell/host-commands/which.ts —— 默认宿主命令：`which`。
//
// 为什么不用 busybox 自带的 which（CONFIG_WHICH）：busybox 的 which 走
// `find_executable()` -> `file_is_executable()`（`access(X_OK)` + `stat` + `S_ISREG`），
// 是**纯文件系统查找**，从不查 applet 表（对比：`BB_EXECVP` 才调 `find_applet_by_name`）。
// 平时 `which ls` 能用，是因为 busybox 安装时按 CONFIG_INSTALL_APPLET_SYMLINKS 造了
// `/bin/ls -> /bin/busybox` 符号链接——which 找到的是**文件**。wasi-sh 是单个 .wasm，
// 从不 make install，没有这些链接，于是 `which ls` 找不到自己的 applet（实测 exit 1）。
//
// 所以这里的语义对齐 `command -v`（也是 zsh 的 which 行为）：
//   1. 名字含 '/' -> 当路径查（常规文件才算命中）；
//   2. 名字是 shell 可解析的（applet / ash 内建 / 宿主命令）-> 打印名字本身；
//   3. 否则沿 $PATH 找常规文件 -> 打印路径。
//  全部命中 exit 0，任一未命中 exit 1（GNU which 一致）。
//
// 输出「名字本身」而不是路径是有意的：`$(which awk)` 得到的 `awk` 仍能被 ash 解析执行，
// 而编造一个不存在的 `/bin/awk` 才是说谎。
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../../env/types';
import type { HostCommandHandler } from '../host-commands';

const USAGE = 'usage: which NAME...\n';

/** 名字含 '/' → 直查路径；否则按 PATH 拼。空 PATH 段跳过（不映射到 cwd） */
function candidates(name: string, pathEnv: string | undefined): string[] {
	if (name.includes('/')) return [name];
	const dirs = (pathEnv ?? '').split(':').filter((d) => d !== '');
	return dirs.map((d) => `${d}/${name}`);
}

/** PATH 上第一个存在的常规文件（fileInfo 的 Result 不抛；目录与不存在都算不匹配） */
async function firstExistingFile(fs: BrowserFileSystem, paths: string[]): Promise<string | undefined> {
	for (const p of paths) {
		const info = await fs.fileInfo(p, BACKGROUND_CONTEXT);
		if (info.ok && info.value.kind === 'file') return p;
	}
	return undefined;
}

/** resolvable = shell 能自行解析的名字（applet + ash 内建 + 已注册宿主命令），见 RESERVED_COMMAND_NAMES */
export function makeWhich(resolvable: ReadonlySet<string>): HostCommandHandler {
	return async (request, fs) => {
		if (request.args.length === 0) {
			return { exitCode: 1, stderr: `which: ${USAGE}` };
		}
		// 选项位保留给真要的人：-a 在 busybox 与 GNU 的默认行为不一致，贸然做容易双标
		if (request.args.some((a) => a.startsWith('-'))) {
			return { exitCode: 1, stderr: 'which: unsupported option (only positional names)\n' };
		}
		const found: string[] = [];
		let allFound = true;
		for (const name of request.args) {
			if (!name.includes('/') && resolvable.has(name)) {
				found.push(name);   // shell 能解析（applet/内建/宿主命令）
				continue;
			}
			const path = await firstExistingFile(fs, candidates(name, request.env?.PATH));
			if (path !== undefined) found.push(path);
			else allFound = false;
		}
		return {
			exitCode: allFound ? 0 : 1,
			stdout: found.length === 0 ? '' : `${found.join('\n')}\n`,
		};
	};
}
