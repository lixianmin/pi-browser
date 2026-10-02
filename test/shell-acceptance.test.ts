// @vitest-environment node
// spec §4.2：spike v2 验收矩阵（**修正版**）进 CI + 「exec → 调用方 OutputAccumulator」截断接缝。
// 原样输出不能照抄的两处修正：CASE 3 先 `mkdir -p /out`（否则重定向本身就失败，原 stdout '0\n' 是错的）；
// CASE 5 的 awk 程序用**单引号**（双引号会被 ash 当变量展开，awk 直接报 Unexpected token）。
// 断言 = exit code + 输出二值（exec 的输出视图合并 stdout/stderr，与上游 Node 实现同口径）。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';

import type { ExecutionEnv } from '../src/env/types';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { createBrowserFileSystem } from '../src/env/backend-idb';
import { execWithOutput } from './helpers/shell-output';
import { OutputAccumulator } from '../src/shell/output-accumulator';

const CTX = BACKGROUND_CONTEXT;

// 用例间独立树：显式 memory:true 双挂载（'/' + '/tmp'，与默认表同形；本文件用例不触 /tmp，路由/跨挂载
// rename 覆盖见 mount/execution-env/sync-session 测试；注册表语义下默认挂载同 dbName 共享内核会让用例互染，spec 桶 A）
const independentEnv = () =>
	createBrowserExecutionEnv({
		mounts: [
			{ prefix: '/', fs: createBrowserFileSystem({ memory: true }) },
			{ prefix: '/tmp', fs: createBrowserFileSystem({ memory: true }) },
		],
	});

interface AcceptanceCase {
	name: string;
	command: string;
	exitCode: number;
	output: string;
}

const CASES: AcceptanceCase[] = [
	{ name: 'CASE 1 重定向 + 读回', command: 'mkdir -p /out && echo hi > /out/a.txt && cat /out/a.txt', exitCode: 0, output: 'hi\n' },
	{ name: 'CASE 2 管道排序', command: 'printf "b\\na\\n" | sort', exitCode: 0, output: 'a\nb\n' },
	{ name: 'CASE 3 管道 wc -c（修正：先建目录）', command: 'mkdir -p /out; echo one > /out/b.txt; cat /out/b.txt | wc -c', exitCode: 0, output: '4\n' },
	{ name: 'CASE 4 控制流 + 变量', command: "sh -c 'for i in 1 2 3; do echo $i; done'", exitCode: 0, output: '1\n2\n3\n' },
	{ name: 'CASE 5 多级管道 + awk（修正：单引号程序）', command: "seq 20 | awk '$1 % 3 == 0' | sort -rn | head -n 2", exitCode: 0, output: '18\n15\n' },
	{ name: 'CASE 6 glob 展开', command: 'mkdir -p /g && echo a > /g/1.txt && echo b > /g/2.txt && echo /g/*.txt', exitCode: 0, output: '/g/1.txt /g/2.txt\n' },
	{ name: 'CASE 7 while 循环', command: 'i=0; while [ $i -lt 3 ]; do echo loop$i; i=$((i+1)); done', exitCode: 0, output: 'loop0\nloop1\nloop2\n' },
	{ name: 'CASE 8 if/else + 变量', command: 'x=5; if [ $x -gt 3 ]; then echo big; else echo small; fi', exitCode: 0, output: 'big\n' },
	{ name: 'CASE 9 命令替换', command: 'echo sum=$(expr 2 + 3)', exitCode: 0, output: 'sum=5\n' },
	{ name: 'CASE 10 退出码 7', command: 'exit 7', exitCode: 7, output: '' },
];

async function execCase(env: ExecutionEnv, command: string) {
	const { result, output, truncation } = await execWithOutput(env, command);
	if (!result.ok) throw new Error(`exec 失败: ${result.error.code} ${result.error.message}`);
	return { exitCode: result.value.exitCode, output, truncation };
}

describe('语义验收矩阵（spike v2 修正版）', () => {
	for (const c of CASES) {
		it(c.name, async () => {
			const env = independentEnv();
			const { exitCode, output } = await execCase(env, c.command);
			expect(exitCode).toBe(c.exitCode);
			expect(output).toBe(c.output);
			await env.cleanup(CTX);
		});
	}
});

describe('输出截断（Task 6 起归调用方）', () => {
	// `capture.limits` 随 0.99.1 的契约一起消失：exec 只交付原始分片，截断/尾保留由调用方的 OutputAccumulator 决定。
	// 按行、按字节（含 lastLinePartial 与 lastLineBytes）的两条原始断言已移到 test/output-accumulator.test.ts，
	// 这里只钉「exec → 调用方累积」这条新接缝仍然通畅。
	it('调用方用受限的 OutputAccumulator 截断 exec 的输出', async () => {
		const env = independentEnv();
		const chunks: string[] = [];
		const result = await env.exec('seq 1 10', { onOutput: (text) => chunks.push(text) }, CTX);
		expect(result.ok).toBe(true);
		const accumulator = new OutputAccumulator({ maxLines: 3, maxBytes: 1024 });
		for (const chunk of chunks) accumulator.append(new TextEncoder().encode(chunk));
		accumulator.finish();
		const snapshot = accumulator.snapshot();
		expect(snapshot.content).toBe('8\n9\n10');
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.truncation.truncatedBy).toBe('lines');
		expect(snapshot.truncation.totalLines).toBe(10);
		await env.cleanup(CTX);
	});
});
