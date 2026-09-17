// @vitest-environment node
// spec §3：createBrowserExecutionEnv —— 默认挂载 '/'→IDB、'/tmp'→内存；shell 默认 busybox。
// 本文件只钉装配面：exec 的 busybox 行为在 shell-exec.test.ts，占位语义在这里用显式 `shell:false` 断言。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT, type ExecutionEnv, type FileError, type Result } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv } from '../src/env/execution-env';
import { createMemoryFileSystem } from '../src/env/backend-memory';

const CTX = BACKGROUND_CONTEXT;
const getOrFail = <T>(r: Result<T, FileError>): T => {
	if (!r.ok) throw new Error(`expected ok, got error: ${r.error.code} ${r.error.message}`);
	return r.value;
};

describe('createBrowserExecutionEnv：shell:false 占位', () => {
	it('shell:false 时 exec 恒返回 shell_unavailable（不抛）', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }], shell: false });
		const r = await env.exec('ls -la', undefined, CTX);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe('shell_unavailable');
	});
});

describe('createBrowserExecutionEnv：fs 代理', () => {
	it('注入 mounts 时经 env 的写入落在注入后端（写读同一后端）', async () => {
		const probe = createMemoryFileSystem();
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: probe }] });
		expect((await env.writeFile('/a.txt', 'hi', CTX)).ok).toBe(true);
		expect(getOrFail(await env.readTextFile('/a.txt', CTX))).toBe('hi');
		expect(getOrFail(await probe.readTextFile('/a.txt', CTX))).toBe('hi');
	});

	it('默认挂载表：/ 可写读，createTempDir 落 /tmp 挂载（跨 mount rename 拒绝）', async () => {
		// vitest 下默认 '/'→createBrowserFileSystem 自动走内存后端（无 indexedDB）；这里只验挂载装配与路由
		const env: ExecutionEnv = createBrowserExecutionEnv();
		expect((await env.writeFile('/notes/a.txt', 'v1', CTX)).ok).toBe(true);
		expect(getOrFail(await env.readTextFile('/notes/a.txt', CTX))).toBe('v1');

		const dir = getOrFail(await env.createTempDir(undefined, CTX));
		expect(dir.startsWith('/tmp/')).toBe(true);
		expect((await env.writeFile(`${dir}/t.txt`, 'tmp-content', CTX)).ok).toBe(true);
		expect(getOrFail(await env.readTextFile(`${dir}/t.txt`, CTX))).toBe('tmp-content');

		const moved = await env.renameFile('/notes/a.txt', '/tmp/moved.txt', CTX);
		expect(moved.ok).toBe(false);
		if (!moved.ok) expect(moved.error.code).toBe('not_supported');

		await env.cleanup(CTX);
	});

	it('cleanup resolve 不抛（上游契约：best-effort）', async () => {
		const env = createBrowserExecutionEnv({ mounts: [{ prefix: '/', fs: createMemoryFileSystem() }] });
		await expect(env.cleanup(CTX)).resolves.toBeUndefined();
	});
});
