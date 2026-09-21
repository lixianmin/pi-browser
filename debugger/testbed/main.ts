// debugger/testbed/main.ts —— 测试宿主页:在本 origin 造两个 IDB 库的样例数据。
// spice-sessions 树结构对齐主包真实布局(会话 jsonl / skills);spice-alt 验证库切换。
// 相对直连 backend(plan 豁免:同仓库工具页),避免把主包 shell/wasi-sh 拖进产物。
import { createBrowserFileSystem } from '../../src/env/backend-idb';

const log = (msg: string) => {
	const el = document.getElementById('log');
	if (el) el.textContent += `${msg}\n`;
};

async function seed(dbName: string, files: Record<string, string>): Promise<void> {
	const fs = createBrowserFileSystem({ dbName, memory: false });
	for (const [path, content] of Object.entries(files)) {
		const r = await fs.writeFile(path, content, {} as never);
		if (!r.ok) throw r.error;
	}
	await fs.flush();
	log(`seeded ${dbName}: ${Object.keys(files).length} files`);
}

document.getElementById('seed')?.addEventListener('click', () => {
	void (async () => {
		try {
			await seed('spice-sessions', {
				'/README.md': '# Testbed session store\n\n样例数据,供 PI Browser 面板调试。\n',
				'/s1/main.jsonl': [
					'{"role":"user","content":"你好"}',
					'{"role":"assistant","content":"你好,有什么可以帮你?"}',
					'{"role":"user","content":"读一下 /skills/echo/SKILL.md"}',
					'',
				].join('\n'),
				'/s1/compaction/summary.md': '# Compaction\n\n早前对话摘要(样例)。\n',
				'/skills/echo/SKILL.md': [
					'---',
					'name: echo',
					'description: 原样复读输入(样例 skill)',
					'---',
					'',
					'# echo',
					'把用户输入原样返回。',
					'',
				].join('\n'),
				'/notes.txt': 'héllo 世界 🎉(UTF-8 多字节样例)',
			});
			await seed('spice-alt', {
				'/alt.txt': '另一个库,用于验证库切换。',
			});
			log('done ✓');
		} catch (e) {
			log(`error: ${String(e)}`);
		}
	})();
});

document.getElementById('wipe')?.addEventListener('click', () => {
	void (async () => {
		for (const db of ['spice-sessions', 'spice-alt']) {
			indexedDB.deleteDatabase(db);
			log(`deleteDatabase(${db}) 已发起`);
		}
	})();
});
