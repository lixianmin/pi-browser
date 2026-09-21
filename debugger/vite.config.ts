// debugger/vite.config.ts —— 面板/devtools/testbed 应用 + background(esm)构建,
// 同时是 vitest 的共享配置(alias 必须对测试生效)。
// 主包连接方式:bun 不支持把 workspace 根包当依赖,这里用 alias 直连源码入口
// (plan 2026-09-21「偏差说明」;仍从包入口 import,不 deep import)。
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@lixianmin/pi-browser': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
		},
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
