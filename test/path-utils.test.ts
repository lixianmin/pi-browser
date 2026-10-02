// Task 9（P2a-2）：path-utils 的浏览器版 5 导出。
// 「Path utilities」块从 test/tools-utils.test.ts 搬来（原名与断言逐字保留），
// 新增的是注入 access 谓词、macOS 变体探测与 expandPath 的浏览器语义。
import { describe, it, expect } from 'vitest';
import { expandPath, pathExists, resolveReadPath, resolveReadPathAsync, resolveToCwd } from '../src/tools/path-utils';

describe('Path utilities', () => {
	it('resolveToCwd makes absolute path', () => {
		expect(resolveToCwd('a.txt', '/tmp')).toBe('/tmp/a.txt');
		expect(resolveToCwd('/abs/b.txt', '/tmp')).toBe('/abs/b.txt');
	});

	it('resolveToCwd 归一 . 与 ..（不许穿出根）', () => {
		expect(resolveToCwd('./a/../b.txt', '/work')).toBe('/work/b.txt');
		expect(resolveToCwd('../../etc/passwd', '/work')).toBe('/etc/passwd');
	});

	it('resolveToCwd 保留空格与非 ASCII（URL API 会百分号编码——本仓用 normalizePath）', () => {
		expect(resolveToCwd('my dir/中文 名.txt', '/')).toBe('/my dir/中文 名.txt');
	});

	it('resolveToCwd 与上游一致地剥 @ 前缀（P2a 新增行为，钉住）', () => {
		expect(resolveToCwd('@a.txt', '/w')).toBe('/w/a.txt');
	});

	it('expandPath 抹掉 @ 前缀、把 Unicode 空格归一为普通空格', () => {
		expect(expandPath('@/work/a.txt')).toBe('/work/a.txt');
		expect(expandPath('a\u2003b\u00A0c')).toBe('a b c');
	});

	it('expandPath 不展开 ~（浏览器无 home，如实保留成虚拟路径）', () => {
		expect(expandPath('~/x')).toBe('~/x');
		expect(resolveToCwd('~/x', '/work')).toBe('/work/~/x');
	});

	it('pathExists：access resolve → true，reject → false', async () => {
		expect(await pathExists('/a', async () => {})).toBe(true);
		expect(await pathExists('/a', async () => { throw new Error('not_found'); })).toBe(false);
	});

	it('pathExists：注入谓词缺失 → 响亮报错，不吞成 false', async () => {
		// P2a 终审 Important 2：TS 调用方有类型保护，但 JS 消费者 / `as any` 移植会漏传——
		// 旧实现的 `catch { return false }` 会把「谓词是坏的」压成「文件不存在」，静默失效。
		await expect(pathExists('/a', undefined as never)).rejects.toThrow(/access predicate/);
	});

	it('resolveReadPathAsync 探 macOS 变体：NFD、弯引号、AM/PM 窄空格', async () => {
		const only = (target: string) => async (p: string): Promise<void> => { if (p !== target) throw new Error('not_found'); };
		// NFD：输入 é(U+00E9) → e + 组合尖音符
		const nfd = 'e\u0301.txt';
		expect(await resolveReadPathAsync('\u00E9.txt', '/w', only('/w/' + nfd))).toBe('/w/' + nfd);
		// 弯引号：' → U+2019
		const curly = '/w/Capture d\u2019écran.png';
		expect(await resolveReadPathAsync("Capture d'écran.png", '/w', only(curly))).toBe(curly);
		// AM/PM：' ' → U+202F（窄不换行空格）
		const ampm = '/w/Shot 10.00.00\u202FAM.png';
		expect(await resolveReadPathAsync('Shot 10.00.00 AM.png', '/w', only(ampm))).toBe(ampm);
	});

	it('resolveReadPathAsync 一个变体都不中 → 回退原解析路径', async () => {
		expect(await resolveReadPathAsync('a.txt', '/w', async () => { throw new Error('not_found'); })).toBe('/w/a.txt');
	});

	it('resolveReadPathAsync：输入里的 U+202F 先被 expandPath 归一为普通空格，变体全不中则回退该解析路径', async () => {
		expect(await resolveReadPathAsync('Shot 10.00.00\u202FAM.png', '/w', async () => { throw new Error('not_found'); }))
			.toBe('/w/Shot 10.00.00 AM.png');
	});

	it('resolveReadPath（同步）只做纯解析，不探变体', () => {
		expect(resolveReadPath('a.txt', '/w')).toBe('/w/a.txt');
	});
});
