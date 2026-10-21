// test/lib-in-sync.test.ts —— 守「改了 src 就必须重新 build 并提交 lib/」（2026-10-21）。
//
// 为什么需要：`lib/` 是**提交进 git 的构建产物**（`dist/` 在 .gitignore 里，故产物目录叫 lib）。
// 消费者（如 spice）经 `github:<sha>` 安装，安装时**不跑构建**——所以源码改了而 lib/ 没重提，
// 装到的就是旧产物，而且没有任何报错。这条测试把「过期产物」变成红灯。
//
// 判据用**重新编译一遍再逐字节比对**，不用 mtime：git checkout 会把所有文件的 mtime 刷成检出时刻，
// mtime 判断在克隆出来的仓库里恒假绿。产物里没有时间戳/路径，编译是确定性的。
//
// 修法（红的时候照做）：`bun run build && git add lib` 后提交。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const LIB = join(ROOT, 'lib');
/** 构建脚本把 src 下的静态资源原样复制进 lib（见 package.json 的 build），产物不参与 tsc。 */
const COPIED_ASSETS = ['shell/busybox.wasm'];
/** 冷编译约 3s；给足余量但别让真挂死变成长等。 */
const COMPILE_TIMEOUT_MS = 60_000;

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

describe('构建产物与源码同步（lib/ 是提交进 git 的产物）', () => {
	it('重新编译的结果与已提交的 lib/ 逐字节一致', () => {
		const out = mkdtempSync(join(tmpdir(), 'pi-browser-lib-'));
		try {
			execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json', '--outDir', out], {
				cwd: ROOT, stdio: 'pipe', timeout: COMPILE_TIMEOUT_MS,
			});
			const fresh = walk(out).map((f) => relative(out, f)).sort();
			const committed = walk(LIB).map((f) => relative(LIB, f)).filter((f) => !COPIED_ASSETS.includes(f)).sort();
			// 先比文件清单：新增/删除的源文件会在这里现形（缺文件比内容不同更好读）
			expect(fresh, 'lib/ 的文件清单与源码编译结果不一致——跑 `bun run build` 重提产物').toEqual(committed);

			const stale = fresh.filter((f) => !readFileSync(join(out, f)).equals(readFileSync(join(LIB, f))));
			expect(stale, `这些产物过期了——跑 \`bun run build\` 并提交 lib/：\n  ${stale.join('\n  ')}`).toEqual([]);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});

	it('复制的静态资源与源码一致（busybox.wasm 在 exec.js 里按 import.meta.url 相对解析）', () => {
		for (const asset of COPIED_ASSETS) {
			expect(readFileSync(join(LIB, asset)).equals(readFileSync(join(ROOT, 'src', asset))), `${asset} 与 src/ 里的源文件不一致——跑 \`bun run build\``).toBe(true);
		}
	});
});
