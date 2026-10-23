// @vitest-environment node
// 日志面（needle `@needle/logo`）：本仓关键路径的打点契约（spec 2026-10-23 §4）。
//
// 为什么单独一个文件：打点是**可观察契约**——级别或字段名一改，宿主侧按字段做的看板/告警就跟着坏。
// 与扩展面那份硬编码名单同理：把它钉成测试，升级 needle 或改打点时这里先红。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stdoutSink, type LogRecord } from '@needle/logo';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { logger } from '../src/logging';
import { asDurableTool } from '../src/tools/durable-tool';
import { writeText } from '../src/tools/fs-ops';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { BACKGROUND_CONTEXT } from '../src/env/context';

const CTX = BACKGROUND_CONTEXT;

/** 本文件收集到的记录（每个用例前清空） */
let records: LogRecord[] = [];
/** 采集 sink：needle 的 sink 收的是**一批**记录 */
const collect = (batch: readonly LogRecord[]): void => { records.push(...batch); };

beforeAll(() => {
	// 默认 logger 带 stdout sink（浏览器/Node 都能看见）；测试里摘掉，免得刷屏
	logger.removeSink(stdoutSink);
	logger.addSink(collect);
	// test/setup.ts 把级别压到 'warn'（免得打点淹没断言输出）；本文件要测 info 级打点，自己调高
	logger.setLevel('info');
});
afterAll(() => {
	logger.removeSink(collect);
	logger.addSink(stdoutSink);
	logger.setLevel('warn');
});
beforeEach(() => { records = []; });
afterEach(() => { logger.flush(); });

/** 取第一条满足条件的记录 */
const first = (predicate: (r: LogRecord) => boolean): LogRecord | undefined => records.find(predicate);

describe('日志面（needle）', () => {
	it('工具调用：起一条（名 + 参数摘要）、收一条（耗时 + 成败）', async () => {
		const tool = {
			name: 'probe',
			description: 'probe',
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
		} as unknown as AgentTool<any>;
		const api = { callId: 'c1', output: () => {} } as unknown as ToolExecutionApi;

		await asDurableTool(tool).execute({ path: '/a.txt' }, api, CTX);
		logger.flush();

		const started = first((r) => r.level === 'info' && r.msg === 'tool call');
		expect(started?.tool).toBe('probe');
		expect(String(started?.args)).toContain('/a.txt');

		const done = first((r) => r.level === 'info' && r.msg === 'tool done');
		expect(done?.tool).toBe('probe');
		expect(typeof done?.durationMs).toBe('number');
	});

	it('工具抛错：记 error（带 stack），异常照原样冒泡', async () => {
		const boom = new Error('boom');
		const tool = {
			name: 'probe',
			description: 'probe',
			parameters: Type.Object({}),
			execute: async () => { throw boom; },
		} as unknown as AgentTool<any>;
		const api = { callId: 'c1', output: () => {} } as unknown as ToolExecutionApi;

		await expect(asDurableTool(tool).execute({}, api, CTX)).rejects.toBe(boom);
		logger.flush();

		const failed = first((r) => r.level === 'error' && r.msg === 'tool failed');
		expect(failed?.tool).toBe('probe');
		expect(String(failed?.message)).toContain('boom');
	});

	it('参数摘要截断：超长入参不会整条进日志', async () => {
		const tool = {
			name: 'probe',
			description: 'probe',
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
		} as unknown as AgentTool<any>;
		const api = { callId: 'c1', output: () => {} } as unknown as ToolExecutionApi;

		await asDurableTool(tool).execute({ content: 'x'.repeat(5000) }, api, CTX);
		logger.flush();

		const started = first((r) => r.msg === 'tool call');
		expect(String(started?.args).length).toBeLessThan(1000);
	});

	it('shell exec：记命令 + cwd + 退出码 + 耗时', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem('/') }] });
		try {
			const result = await env.exec('echo hi', { cwd: '/' }, CTX);
			expect(result.ok).toBe(true);
			logger.flush();

			const record = first((r) => r.msg === 'shell exec');
			expect(record?.command).toBe('echo hi');
			expect(record?.cwd).toBe('/');
			expect(record?.exitCode).toBe(0);
			expect(typeof record?.durationMs).toBe('number');
		} finally {
			await env.cleanup(CTX);
		}
	});

	it('写文件：记路径与字节数', async () => {
		const fs = createMemoryFileSystem('/');
		await writeText(fs, '/a.txt', 'hello', CTX);
		logger.flush();

		const record = first((r) => r.msg === 'file write');
		expect(record?.path).toBe('/a.txt');
		expect(record?.bytes).toBe(5);
	});
});
