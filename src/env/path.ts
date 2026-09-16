/** 归一化为 '/'-根绝对路径（纯 JS，无 node:path——本包浏览器/Node 同构） */
export function normalizePath(p: string): string {
	const rooted = p.startsWith('/') ? p : `/${p}`;
	const stack: string[] = [];
	for (const seg of rooted.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') { stack.pop(); continue; }
		stack.push(seg);
	}
	return `/${stack.join('/')}`;
}
