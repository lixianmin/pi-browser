// @vitest-environment node
// P5：会话 JSONL 格式与上游 1.0.0 对照 —— 本仓浏览器 fs 写出的文件能被 `parseSessionEntries` 读回、
// 且 `buildSessionContext` 产出与写入一致。
//
// 为什么对照落在这三个纯函数上（spec P5 / 裁决）：
//   · 计划原文写「把对照目标从 0.99.1 的 `JsonlSessionRepo` 换成 1.0.0 的 `SessionManager` 容器」——
//     实测**不可行**：1.0.0 的 `SessionManager` 是 `private constructor` + 直接 `appendFileSync` /
//     `openSync` / `existsSync`（node:fs），喂不进本仓的 `BrowserFileSystem`；而 0.99.1 那个
//     `JsonlSessionRepo` 在 pi-agent-core@1.0.0 里已经**整个消失**（1.0.0 的 agent-core 只剩
//     agent / agent-loop / proxy / stream-fn / types 五个模块）。P6 升版本时它必然断，所以这里
//     **不依赖它**：写入端由测试自己按 v3 格式拼（会话写入是宿主的事，本包没有会话写手）。
//   · 真正要守的不变量是**文件格式**：头部 + 条目行、`CURRENT_SESSION_VERSION = 3`、条目能被解析、
//     且 `buildSessionContext` 还原出的消息与写入时一致。这三个函数都在 1.0.0 的
//     `core/session-manager.js` 里，是纯函数（模块顶部的 node:fs 导入在 node 测试环境下可用，
//     但这三个函数不碰 fs）。
//   · `pi-durable/testing` 的 storage-conformance 仍然不引入（既有裁决：那是 durable 自己的模型，
//     与本仓「单写者 fs + session JSONL」不是同一抽象）。
import './helpers/idb';
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '../src/env/context';
import { createBrowserFileSystem, resetFsKernelRegistry } from '../src/index';
import {
	CURRENT_SESSION_VERSION, parseSessionEntries, buildSessionContext,
} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';

const CTX = BACKGROUND_CONTEXT;

/** 按 1.0.0 的 v3 格式拼一个会话文件：头部一行 + 每个条目一行。 */
const sessionFile = (): string => {
	const header = { type: 'session', version: CURRENT_SESSION_VERSION, id: 's1', timestamp: '2026-10-02T08:00:00.000Z', cwd: '/projects/x' };
	const entries = [
		{ type: 'message', id: 'e1', parentId: null, timestamp: '2026-10-02T08:00:01.000Z', message: { role: 'user', content: '你好', timestamp: 1 } },
		{ type: 'custom', id: 'e2', parentId: 'e1', timestamp: '2026-10-02T08:00:02.000Z', customType: 'spiceRound', data: { n: 1 } },
		{ type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-10-02T08:00:03.000Z', message: { role: 'user', content: '继续', timestamp: 3 } },
	];
	return [header, ...entries].map((line) => JSON.stringify(line)).join('\n') + '\n';
};

describe('会话 JSONL：浏览器 fs 写出 → 上游 1.0.0 读回（P5）', () => {
	it('版本号 = 上游 CURRENT_SESSION_VERSION（本仓不另定版本号）', () => {
		expect(CURRENT_SESSION_VERSION).toBe(3);
	});

	it('浏览器 fs（真 IDB）写出的文件，上游 parseSessionEntries 原样读回', async () => {
		const fs = createBrowserFileSystem({ dbName: 'p5-db', memory: false });
		const content = sessionFile();
		const written = await fs.writeFile('/sessions/s1.jsonl', content, CTX);
		expect(written.ok).toBe(true);
		await fs.flush();

		// 真 IDB：新实例（= 刷新页面）读回，验证「写进去的东西真的落盘」，而不是内存里那份
		resetFsKernelRegistry();
		const reopened = createBrowserFileSystem({ dbName: 'p5-db', memory: false });
		const read = await reopened.readTextFile('/sessions/s1.jsonl', CTX);
		expect(read.ok && read.value).toBe(content);

		const entries = parseSessionEntries(read.ok ? read.value : '');
		expect(entries.map((e) => e.type)).toEqual(['session', 'message', 'custom', 'message']);
		expect(entries[0]).toMatchObject({ type: 'session', version: 3, id: 's1', cwd: '/projects/x' });

		await reopened.cleanup(CTX);
		await fs.cleanup(CTX);
	});

	it('buildSessionContext 产出的消息与写入时一致（只有 message 进 LLM 上下文，custom 不进）', async () => {
		const entries = parseSessionEntries(sessionFile());
		// buildSessionContext 吃的是条目（不含文件头那行 session）
		const context = buildSessionContext(entries.filter((e) => e.type !== 'session'));
		expect(context.messages.map((m) => (m.role === 'user' ? m.content : m.role))).toEqual(['你好', '继续']);
		// 投影的另两个字段也带上（没有 model_change / thinking_level_change 条目时是上游的缺省值：
		// thinkingLevel 缺省 'off'、model 缺省 null —— 逐字实测，不猜）
		expect(context.thinkingLevel).toBe('off');
		expect(context.model).toBeNull();
	});

	it('含 compaction 条目时：compactionSummary 消息被还原（自持 compaction 的形状与上游接得上）', () => {
		const content = [
			JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-10-02T08:00:00.000Z', cwd: '/projects/x' }),
			JSON.stringify({ type: 'message', id: 'e1', parentId: null, timestamp: '2026-10-02T08:00:01.000Z', message: { role: 'user', content: '长对话', timestamp: 1 } }),
			JSON.stringify({
				type: 'compaction', id: 'e2', parentId: 'e1', timestamp: '2026-10-02T08:00:02.000Z',
				summary: '之前的对话摘要', firstKeptEntryId: 'e1', tokensBefore: 5000,
			}),
			JSON.stringify({ type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-10-02T08:00:03.000Z', message: { role: 'user', content: '之后', timestamp: 3 } }),
		].join('\n') + '\n';
		const entries = parseSessionEntries(content);
		const context = buildSessionContext(entries.filter((e) => e.type !== 'session'));
		const roles = context.messages.map((m) => m.role);
		// 摘要消息（compactionSummary）+ 首条 user + 末条 user；custom 类条目不进上下文
		expect(roles).toContain('compactionSummary');
		const summary = context.messages.find((m) => m.role === 'compactionSummary');
		expect(summary).toMatchObject({ role: 'compactionSummary', summary: '之前的对话摘要', tokensBefore: 5000 });
	});
});
