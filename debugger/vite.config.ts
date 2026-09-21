// debugger/vite.config.ts —— 应用构建:panel / devtools / testbed(html)+ background(esm 入口)。
// background.js 的文件名是 manifest 契约,用 entryFileNames 钉死;其余走 assets 哈希名。
// 主包连接:alias 直连源码入口(bun 不支持 workspace 根包被成员依赖,plan 偏差说明)。
import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const P = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	plugins: [react(), copyManifest(), pruneOrphanAssets()],
	resolve: {
		alias: {
			'@lixianmin/pi-browser': P('../src/index.ts'),
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true, // app 构建先行清空;bridge 构建随后追加(emptyOutDir:false)
		rollupOptions: {
			input: {
				panel: P('./src/panel/panel.html'),
				devtools: P('./src/devtools/devtools.html'),
				testbed: P('./testbed/index.html'),
				background: P('./src/background/background.ts'),
			},
			output: {
				entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
				chunkFileNames: 'assets/[name]-[hash].js',
				assetFileNames: 'assets/[name]-[hash][extname]',
			},
		},
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});

/** manifest.json 原样拷入 dist(自写 10 行,不引 @crxjs:长期 beta,维护风险;spec §5) */
function copyManifest() {
	return {
		name: 'copy-manifest',
		closeBundle() {
			fs.copyFileSync(P('./manifest.json'), P('./dist/manifest.json'));
		},
	};
}

/**
 * 清理孤儿资产:主包连接走文件路径 alias,包级 sideEffects:false 作用不到,
 * wasi-sh 的 busybox wasm 被发射但代码引用全部摇掉(运行时零引用)。只删
 * 「dist 内无任何 js/css 引用其文件名」的资产,防未来引用变活时误删。
 */
function pruneOrphanAssets() {
	return {
		name: 'prune-orphan-assets',
		closeBundle() {
			const dist = P('./dist');
			const walk = (dir: string): string[] =>
				fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
					const p = `${dir}/${e.name}`;
					return e.isDirectory() ? walk(p) : [p];
				});
			const files = walk(dist);
			const code = files.filter((f) => /\.(js|css|html)$/.test(f));
			for (const f of files.filter((f) => f.endsWith('.wasm'))) {
				const name = f.split('/').pop() as string;
				const referenced = code.some((c) => fs.readFileSync(c, 'utf8').includes(name));
				if (!referenced) fs.unlinkSync(f);
			}
		},
	};
}
