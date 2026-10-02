// 批 2 B-3：本仓 `AgentTool`（七工厂的产物）→ pi-durable `ToolRegistration` 的适配（`asDurableTool`）。
//
// 断言三件事：
//   ① 适配是**恒等**的：同一个工具经适配后跑真 fs，`content`/`details` 与直调工厂逐字相同；
//      `name`/`description`/`parameters`（`Tool<TParameters>` 两边共有的那三个字段）直传。
//   ② 唯一的形状差（流式通道）接上了：`AgentTool.execute` 的 `onUpdate` → `ToolExecutionApi.output`。
//      这一条用**合成工具**：`grep -rn onUpdate src/tools/` 里七工厂的参数名全是 `_onUpdate`（都没用），
//      真实调用没有可断言的流，所以桥本身用合成工具守。真调用那一侧由 ① / ③ 覆盖。
//   ③ 适配层注释里「七工厂都不产 `structuredContent`」这个前提由最后一条用例守住（顺带把七个都跑过一遍）。
import { describe, it, expect, beforeEach } from 'vitest';
import { Type } from 'typebox';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { FileError } from '@earendil-works/pi-durable/env';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import type { BrowserFileSystem } from '../src/env/types';
import {
	asDurableTool,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from '../src/index';
import { editOps, findOps, grepOps, lsOps, readOps, writeOps } from './helpers/tool-operations';

const CTX = BACKGROUND_CONTEXT;

/** `ToolExecutionApi` 有二十几个成员，装配时一个都不用得到；只接适配层真正碰的 `callId` 与 `output`。 */
const recorder = (): { api: ToolExecutionApi; chunks: string[] } => {
	const chunks: string[] = [];
	const api = {
		callId: 'call-1',
		output: (chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		},
	} as unknown as ToolExecutionApi;
	return { api, chunks };
};

/** 工具失败抛的是 FileError（带 FileErrorCode）；这里取 code 做断言 */
const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
	try {
		await promise;
	} catch (e) {
		expect(e).toBeInstanceOf(FileError);
		return (e as FileError).code;
	}
	throw new Error('expected the tool call to reject');
};

const seed = async (fs: BrowserFileSystem, files: Record<string, string>): Promise<void> => {
	for (const [path, content] of Object.entries(files)) {
		const written = await fs.writeFile(path, content, CTX);
		if (!written.ok) throw written.error;
	}
};

describe('asDurableTool: AgentTool → pi-durable ToolRegistration', () => {
	const emptySchema = Type.Object({});
	let fs: BrowserFileSystem;
	beforeEach(async () => {
		fs = createMemoryFileSystem();
		await seed(fs, { 'sketch.ino': 'pinMode(2, OUTPUT);\ndigitalWrite(2, HIGH);' });
	});

	it('恒等：read 经适配层跑真 fs，content/details 与直调工厂一致，name/description/parameters 直传', async () => {
		const tool = createReadTool('/', { operations: readOps(fs) });
		const direct = await tool.execute('call-1', { path: 'sketch.ino' });

		const registration = asDurableTool(tool);
		expect(registration.name).toBe('read');
		expect(registration.description).toBe(tool.description);
		expect(registration.parameters).toBe(tool.parameters);

		const viaDurable = await registration.execute({ path: 'sketch.ino' }, recorder().api, CTX);
		expect(viaDurable.content).toEqual(direct.content);
		expect(viaDurable.details).toEqual(direct.details);
		expect(viaDurable.isError).toBeUndefined();
	});

	it('流式：onUpdate 的文本块按序进 api.output（图片块不进流），最终结果不受影响', async () => {
		const streaming: AgentTool<typeof emptySchema> = {
			name: 'streaming',
			label: 'streaming',
			description: '合成工具：真调用没有可断言的流（见文件头）',
			parameters: emptySchema,
			execute: async (_toolCallId, _params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: 'text', text: '一' }], details: undefined });
				onUpdate?.({ content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }], details: undefined });
				onUpdate?.({ content: [{ type: 'text', text: '二' }], details: undefined });
				return { content: [{ type: 'text', text: '一二' }], details: { seen: 2 } };
			},
		};

		const { api, chunks } = recorder();
		const result = await asDurableTool(streaming).execute({}, api, CTX);
		expect(chunks).toEqual(['一', '二']);
		expect(result.content).toEqual([{ type: 'text', text: '一二' }]);
		expect(result.details).toEqual({ seen: 2 });
	});

	it('isError 直传：bash 退出码非 0 时结果带 isError（与直调工厂一致）', async () => {
		const tool = createBashTool('/', { operations: { exec: async () => ({ exitCode: 1 }) } });
		const direct = await tool.execute('call-1', { command: 'false' });

		const viaDurable = await asDurableTool(tool).execute({ command: 'false' }, recorder().api, CTX);
		expect(direct.isError).toBe(true);
		expect(viaDurable.isError).toBe(true);
		expect(viaDurable.content).toEqual(direct.content);
		expect(viaDurable.details).toEqual(direct.details);
	});

	it('抛错不吞：read 读不存在的文件，适配层与直调工厂抛同一个 FileError code', async () => {
		const tool = createReadTool('/', { operations: readOps(fs) });
		expect(await rejectionCode(asDurableTool(tool).execute({ path: 'nope.txt' }, recorder().api, CTX))).toBe('not_found');
		expect(await rejectionCode(tool.execute('call-1', { path: 'nope.txt' }))).toBe('not_found');
	});

	it('七工具都能经适配层跑通，且都不产 structuredContent（守住适配层丢弃它的前提）', async () => {
		// 七个工厂的 `parameters` 各不相同，塞进一个数组就得抹掉那个具体类型（只在这一处抹）
		type AnyTool = AgentTool<any, any>;
		const calls: Array<[string, AnyTool, unknown]> = [
			['read', createReadTool('/', { operations: readOps(fs) }), { path: 'sketch.ino' }],
			['write', createWriteTool('/', { operations: writeOps(fs) }), { path: 'new.txt', content: 'x' }],
			['edit', createEditTool('/', { operations: editOps(fs) }), { path: 'sketch.ino', edits: [{ oldText: 'HIGH', newText: 'LOW' }] }],
			['grep', createGrepTool('/', { fs }), { pattern: 'pinMode' }],
			['ls', createLsTool('/', { operations: lsOps(fs) }), {}],
			['find', createFindTool('/', { operations: findOps(fs) }), { pattern: '*.ino' }],
			['bash', createBashTool('/', { operations: { exec: async () => ({ exitCode: 0 }) } }), { command: 'true' }],
		];
		for (const [name, tool, args] of calls) {
			const { api, chunks } = recorder();
			const result = await asDurableTool(tool).execute(args, api, CTX);
			expect(result, name).not.toHaveProperty('structuredContent');
			expect(result.content?.length ?? 0, name).toBeGreaterThan(0);
			expect(chunks, name).toEqual([]);
		}
	});
});
