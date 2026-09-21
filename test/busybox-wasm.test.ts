// @vitest-environment node
// 自带 busybox.wasm 的回归测试（src/shell/busybox.wasm，由 scripts/build-busybox.sh 产出）。
//
// 这些断言钉的是「为什么必须用自带 wasm 而不是上游 wasi-sh 那份」：
//   ① find 的 -path/-maxdepth/-mtime 等选项（上游 busybox.config 裁掉了，用户脚本因此撞墙）；
//   ② `--help` 打真实 usage（上游 SHOW_USAGE 关闭时 `--help` 静默 exit 0，是静默错误）。
// 走 createBrowserExecutionEnv 的 inline 路径——于是「exec.ts 默认加载自带 wasm」这条接线也被覆盖。
import { describe, it, expect } from 'vitest';
import { applyShellOutputUpdate, BACKGROUND_CONTEXT, type ShellOutputUpdate, type ShellOutputView } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv } from '../src/index';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const CTX = BACKGROUND_CONTEXT;

/** 命令输出只经 onUpdate 交付（ShellExecResult 只有 exitCode + 截断元数据），与其它 shell 测试同法累积 */
async function execWithOutput(command: string, files: Record<string, string> = {}) {
	const fs = createMemoryFileSystem();
	for (const [path, content] of Object.entries(files)) await fs.writeFile(path, content, CTX);
	const env2 = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs }] });
	let view: ShellOutputView | undefined;
	const result = await env2.exec(command, { onUpdate: (update: ShellOutputUpdate) => { view = applyShellOutputUpdate(view, update); } }, CTX);
	await env2.cleanup(CTX);
	return { result, output: view?.text ?? '' };
}

describe('自带 busybox.wasm：find 选项', () => {
	it('find -name -path 组合可用（用户脚本的原形状）', async () => {
		const { result, output } = await execWithOutput(
			`find / -name '*.json' -path '*artifacts*' 2>/dev/null`,
			{ '/projects/x/artifacts/a.json': '{}', '/projects/x/b.json': '{}' });

		expect(result.ok && result.value.exitCode).toBe(0);
		expect(output).toBe('/projects/x/artifacts/a.json\n');
	});

	it('find -maxdepth / -type / -mtime 不再报 unrecognized', async () => {
		const { result, output } = await execWithOutput(
			'find / -maxdepth 1 -type d 2>&1',
			{ '/a/keep.txt': 'x' });

		expect(result.ok && result.value.exitCode).toBe(0);
		expect(output).not.toMatch(/unrecognized/);
		expect(output).toContain('/a');
	});
});

describe('自带 busybox.wasm：SHOW_USAGE', () => {
	it('--help 打真实 usage（不是静默 exit 0）', async () => {
		const { result, output } = await execWithOutput( 'ls --help 2>&1');
		expect(result.ok && result.value.exitCode).toBe(0);
		expect(output).toMatch(/Usage: ls/);
	});
});

describe('自带 busybox.wasm：新增 applet', () => {
	it('base64 / sha256sum / tree 可用', async () => {
		const a = await execWithOutput( "printf 'hi' | base64");
		expect(a.output).toBe('aGk=\n');

		const b = await execWithOutput( "printf 'hi' | sha256sum | cut -c1-8");
		expect(b.output).toBe('8f434346\n');

		const c = await execWithOutput( 'tree /d 2>&1', { '/d/f.txt': 'x' });
		expect(c.output).toMatch(/f\.txt/);
	});
});
