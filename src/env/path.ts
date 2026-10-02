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

/** 取父目录（纯 JS，node:path `dirname` 的浏览器替身）。根目录的父目录仍是 `/`。 */
export function dirname(p: string): string {
	const abs = normalizePath(p);
	const index = abs.lastIndexOf('/');
	return index <= 0 ? '/' : abs.slice(0, index);
}
