// debugger/vite.bridge.config.ts —— bridge.js 单独构建:iife、固定文件名(manifest 无需
// 声明它,executeScript files:['bridge.js'] 按扩展根相对路径取)。app 构建之后跑,
// emptyOutDir:false 保护已产出文件。format iife 要求单入口(spec §3 常驻 bridge)。
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
	resolve: {
		alias: {
			'@lixianmin/pi-browser': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: false,
		rollupOptions: {
			input: fileURLToPath(new URL('./src/bridge/entry.ts', import.meta.url)),
			output: {
				format: 'iife',
				entryFileNames: 'bridge.js',
			},
		},
	},
});
