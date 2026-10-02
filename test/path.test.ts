// Plan 7b T6a 平移：normalizePath 用例。
// 源：spice `packages/harness/test/session-fs.test.ts` 首个用例「绝对/相对路径归一化；joinPath 解析 . 与 ..」。
// spice 没有直接测 normalizePath 的用例——它只经 fs.absolutePath / fs.joinPath / fs.canonicalPath 间接覆盖；
// 这里把该用例的三个期望值原样落到 normalizePath（迁出的三个函数体都只是 `normalizePath(...)` 的薄壳）。
import { describe, it, expect } from 'vitest';
import { normalizePath, dirname } from '../src/env/path';

describe('normalizePath：路径归一（Plan 7b T6a 平移）', () => {
	it('绝对/相对路径归一化；解析 . 与 ..', () => {
		expect(normalizePath('a/b.txt')).toBe('/a/b.txt');        // ← fs.absolutePath('a/b.txt')
		expect(normalizePath('/a/b/../c.txt')).toBe('/a/c.txt');  // ← fs.joinPath(['/a', 'b', '..', 'c.txt'])
		expect(normalizePath('./x/./y')).toBe('/x/y');            // ← fs.canonicalPath('./x/./y')
	});
});

describe('dirname（P2b：node:path dirname 的浏览器替身）', () => {
	it('根、多层、无目录、尾斜杠四个输入', () => {
		expect(dirname('/')).toBe('/');
		expect(dirname('a')).toBe('/');
		expect(dirname('/d/inner.txt')).toBe('/d');
		expect(dirname('deep/nested/a.txt')).toBe('/deep/nested');
		expect(dirname('/a/b/')).toBe('/a');
	});
});
