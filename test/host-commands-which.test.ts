// @vitest-environment node
// S2.1 默认宿主命令的单元测试（which / mount）。
//   走 handler 直接调用而不是 exec：两个命令都要 fs/挂载表，只能跑 worker 路径，
//   vitest 不起真 worker（worker e2e 由浏览器侧覆盖）。
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem, MountEntry } from '../src/env/types';
import { createMemoryFileSystem } from '../src/env/backend-memory';
import { RESERVED_COMMAND_NAMES, createHostCommandChannel, createHostCommandResponder, createHostCommandSharedBuffer, hostCommandNames, type HostCommandHandler, type HostCommandRequest, type HostCommandResult } from '../src/shell/host-commands';
import { createDefaultHostCommands } from '../src/shell/host-commands/defaults';
import { makeWhich } from '../src/shell/host-commands/which';
import { makeMount } from '../src/shell/host-commands/mount';

const CTX = BACKGROUND_CONTEXT;

/** 灌一个 fs + 造一个 which handler（resolvable 模拟 applet/内建/宿主命令名单） */
async function withFs(seed: Record<string, string>, resolvable: string[] = []): Promise<{ fs: BrowserFileSystem; which: HostCommandHandler }> {
	const fs = createMemoryFileSystem();
	for (const [path, content] of Object.entries(seed)) await fs.writeFile(path, content, CTX);
	return { fs, which: makeWhich(new Set(resolvable)) };
}

const req = (name: string, args: string[], env?: Record<string, string>, mounts?: MountEntry[]): HostCommandRequest =>
	({ name, args, cwd: '/', env, mounts });

describe('which（解析式：applet/内建/宿主命令 + PATH 文件）', () => {
	it('名字是 shell 可解析的（applet）：打印名字本身、退出 0 —— busybox 的 which 在这里会误报找不到', async () => {
		const { fs, which } = await withFs({}, ['awk', 'ls', 'cd']);
		const result = await which(req('which', ['awk'], { PATH: '/' }), fs);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('awk\n');
	});

	it('名字是 ash 内建（cd）：同样算命中', async () => {
		const { fs, which } = await withFs({}, ['cd', 'export']);
		expect((await which(req('which', ['cd']), fs)).exitCode).toBe(0);
	});

	it('PATH 上的常规文件：打印路径、退出 0', async () => {
		const { fs, which } = await withFs({ '/usr/bin/python': 'fake' });
		const result = await which(req('which', ['python'], { PATH: '/usr/bin' }), fs);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('/usr/bin/python\n');
	});

	it('未命中：空 stdout、退出 1、stderr 无噪音（GNU 语义）', async () => {
		const { fs, which } = await withFs({ '/usr/bin/python': 'fake' }, ['awk']);
		const result = await which(req('which', ['python2'], { PATH: '/usr/bin' }), fs);

		expect(result.exitCode).toBe(1);
		expect(result.stdout ?? '').toBe('');
		expect(result.stderr).toBeUndefined();
	});

	it('多个名字（真实场景 which python python2 awk node）：命中的打出来、退出 1', async () => {
		const { fs, which } = await withFs({}, ['awk']);
		const result = await which(req('which', ['python', 'python2', 'awk', 'node'], { PATH: '/' }), fs);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('awk\n');
	});

	it('PATH 多个目录：只输出第一个命中的', async () => {
		const { fs, which } = await withFs({ '/bin/python': 'b', '/usr/bin/python': 'u' });
		const result = await which(req('which', ['python'], { PATH: '/usr/bin:/bin' }), fs);

		expect(result.stdout).toBe('/usr/bin/python\n');
	});

	it('名字含 /：直查路径，不走 PATH', async () => {
		const { fs, which } = await withFs({ '/opt/bin/python': 'fake' });
		const result = await which(req('which', ['/opt/bin/python'], { PATH: '/nowhere' }), fs);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('/opt/bin/python\n');
	});

	it('目录不算命中（kind 必须是 file）', async () => {
		const fs = createMemoryFileSystem();
		await fs.createDir('/usr/bin/python', undefined, CTX);
		const result = await makeWhich(new Set())(req('which', ['python'], { PATH: '/usr/bin' }), fs);

		expect(result.exitCode).toBe(1);
		expect(result.stdout ?? '').toBe('');
	});

	it('PATH 未传 / 为空：无候选；非 applet 名 → 退出 1', async () => {
		const { fs, which } = await withFs({ '/usr/bin/python': 'fake' });
		expect((await which(req('which', ['python'], {}), fs)).exitCode).toBe(1);
		expect((await which(req('which', ['python'], { PATH: '' }), fs)).exitCode).toBe(1);
	});

	it('无参：exit 1 + usage', async () => {
		const { fs, which } = await withFs({});
		const result = await which(req('which', []), fs);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/usage/);
	});

	it('接选项（-a 等）：明确拒绝，不假装支持', async () => {
		const { fs, which } = await withFs({});
		const result = await which(req('which', ['-a', 'python']), fs);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/unsupported option/);
	});
});

describe('mount（列出挂载表）', () => {
	it('每个挂载点一行 prefix on browser-fs', async () => {
		const mounts: MountEntry[] = [
			{ prefix: '/', fs: createMemoryFileSystem() },
			{ prefix: '/tmp', fs: createMemoryFileSystem() },
		];
		const result = await makeMount()(req('mount', [], undefined, mounts), createMemoryFileSystem());

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('/ on browser-fs\n/tmp on browser-fs\n');
	});

	it('没有挂载表（inline 路径）：明确报错，不假装成功', async () => {
		const result = await makeMount()(req('mount', []), createMemoryFileSystem());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/挂载表/);
	});
});

describe('宿主命令收到挂载表（responder 的接线）', () => {
	it('responder 把 store.mounts 注入 request.mounts，且 mount 端到端能列出挂载点', async () => {
		const mounts: MountEntry[] = [
			{ prefix: '/', fs: createMemoryFileSystem() },
			{ prefix: '/tmp', fs: createMemoryFileSystem() },
		];
		const seen: HostCommandRequest[] = [];
		const respond = createHostCommandResponder({ mounts }, {
			probe: (request) => { seen.push(request); return { exitCode: 0 }; },
			mount: makeMount(),
		});
		const { hostSide, guestSide } = createHostCommandChannel(createHostCommandSharedBuffer());
		const empty = { deleted: [], dirs: [], written: [] };

		const seq = guestSide.send({ name: 'probe', args: [], cwd: '/', changes: empty });
		await hostSide.respondOnce(respond);
		guestSide.read(seq);
		expect(seen[0]?.mounts?.map((m) => m.prefix)).toEqual(['/', '/tmp']);

		const seq2 = guestSide.send({ name: 'mount', args: [], cwd: '/', changes: empty });
		await hostSide.respondOnce(respond);
		expect(guestSide.read(seq2)).toMatchObject({ exitCode: 0, stdout: '/ on browser-fs\n/tmp on browser-fs\n' });
		hostSide.stop();
	});
});

describe('默认宿主命令注册表', () => {
	it('包含 which 与 mount，且不与 applet/内建同名', () => {
		const defaults = createDefaultHostCommands(RESERVED_COMMAND_NAMES);
		expect(typeof defaults.which).toBe('function');
		expect(typeof defaults.mount).toBe('function');
		expect(() => hostCommandNames(defaults)).not.toThrow();
		expect(hostCommandNames(defaults).sort()).toEqual(['mount', 'which']);
	});

	it('which 的 resolvable 含调用方注册的宿主命令名', async () => {
		const resolvable = new Set<string>([...RESERVED_COMMAND_NAMES, 'mytool']);
		const which = createDefaultHostCommands(resolvable).which as HostCommandHandler;
		const result: HostCommandResult = await which(req('which', ['mytool']), createMemoryFileSystem());
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('mytool\n');
	});
});
