// src/tools/path-utils.ts —— 工具侧路径解析（Task 5）。
// 平移源：spice `packages/harness/src/agent/tools/path-utils.ts`，只有 `resolveToCwd` 保留。
//
// 两处相对 spice 的偏离：
//   ① resolveToCwd 不用 URL API，改走本仓既有的 `normalizePath`（env/path）。spice 用 `new URL(filePath, base)`
//      是为了「相对 cwd 拼 + 归一」，代价是 URL 语义会把空格/非 ASCII 百分号编码（`a b.txt` → `a%20b.txt`），
//      对真实 fs 路径是错解；本仓已有 pure-JS 归一化，一处实现一处分词。
//   ② 删 isReadOnlyPath。那是 spice 域的 docs/ 白名单（知识库/技能库/spec/AGENTS.md），
//      pi-browser 是通用 fs 库、没有这些目录概念；保留会把 spice 的项目布局烧进公共 API。

import { normalizePath } from '../env/path';

/** 相对路径解析为绝对归一化路径（基于 cwd）。 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return normalizePath(filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`);
}
