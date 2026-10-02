// test/image-process.test.ts —— 图片处理（`src/tools/image-process.ts`）的契约测试。
//
// 覆盖三件事：
//   ① 未注入 photon 的退化路径（只查 base64 字节上限）；
//   ② 注入 photon 后的**上游行为**：`resizeImage` 被调用、hints 逐字（转换提示 + 尺寸说明）、
//      `autoResizeImages: false` 不调它、缩不到限内就降级成那句说明；
//   ③ 非支持格式 → 走 `convertImageBytesToPng`，转不动/没注入就回上游那句转换失败文案。
//
// 载荷保真由「参数逐字断言」+「hints 文案逐字断言」钉住；photon 本身是真 wasm，测不了也不该测，
// 它由宿主注入（见 image-process.ts 文件头）。
import { describe, it, expect, vi } from 'vitest';
import { processImage, formatDimensionNote, base64Length, type ImagePhoton, type ResizedImage } from '../src/tools/image-process';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0]);
const resized = (over: Partial<ResizedImage> = {}): ResizedImage => ({
	data: 'BASE64',
	mimeType: 'image/jpeg',
	originalWidth: 4000,
	originalHeight: 3000,
	width: 2000,
	height: 1500,
	wasResized: true,
	...over,
});

/** 注入的假 photon：两个方法都是 spy，返回值可指定。 */
function fakePhoton(over: Partial<ImagePhoton> = {}) {
	return {
		resizeImage: vi.fn(async () => resized()),
		convertImageBytesToPng: vi.fn(async () => PNG),
		...over,
	} satisfies ImagePhoton;
}

describe('processImage：未注入 photon（退化路径）', () => {
	it('限内图片：原样 base64 投递，mimeType 不变，无 hints', async () => {
		const r = await processImage(PNG, 'image/png');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.mimeType).toBe('image/png');
		expect(r.hints).toEqual([]);
		expect(r.data).toBe(btoa(String.fromCharCode(...PNG)));
	});

	it('超限图片：ok:false + 上游那句文案（阈值 = 上游 4.5MB base64）', async () => {
		const big = new Uint8Array(3.6 * 1024 * 1024);
		const r = await processImage(big, 'image/png');
		expect(r).toEqual({ ok: false, message: '[Image omitted: could not be resized below the inline image size limit.]' });
	});

	it('autoResizeImages: false → 不查上限，原样投递（上游语义：关掉就不管尺寸）', async () => {
		const big = new Uint8Array(3.6 * 1024 * 1024);
		const r = await processImage(big, 'image/png', { autoResizeImages: false });
		expect(r.ok).toBe(true);
	});

	// 4.5MB 边界的方向要钉住：上游是严格小于（`inputBase64Size < maxBytes`），恰好等于上限时
	// 上游会走缩放尝试；本仓的退化路径必须同向，否则边界会被后来人改反。
	it('上限恰好相等 → 不投递（严格小于，与上游同向）；差一字节 → 投递', async () => {
		const exact = base64Length(PNG.length);
		expect((await processImage(PNG, 'image/png', { resizeOptions: { maxBytes: exact } })).ok).toBe(false);
		expect((await processImage(PNG, 'image/png', { resizeOptions: { maxBytes: exact + 1 } })).ok).toBe(true);
	});

	// 分块 btoa 的多 chunk 往返：只断 `ok === true` 的话，`String.fromCharCode(...)` 越界抛
	// RangeError 这类失败不会被发现（那会让图片变成一次硬失败而不是降级）。
	it('多 chunk 的 base64 往返正确（32768 实参展开不是静默的）', async () => {
		const big = new Uint8Array(200_000);
		for (let i = 0; i < big.length; i++) big[i] = i % 256;
		const r = await processImage(big, 'image/png', { autoResizeImages: false });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const back = atob(r.data);
		expect(back.length).toBe(big.length);
		expect(new Uint8Array([...back].map((c) => c.charCodeAt(0)))).toEqual(big);
	});

	it('resizeOptions.maxBytes 覆盖缺省上限（构造期兜底档真的被消费）', async () => {
		const r = await processImage(PNG, 'image/png', { resizeOptions: { maxBytes: 8 } });
		expect(r.ok).toBe(false);
	});

	it('四种支持格式的 mime 归一（gif / webp 分支原本零覆盖）', async () => {
		for (const [input, expected] of [
			['image/png', 'image/png'], ['image/jpeg', 'image/jpeg'], ['image/jpg', 'image/jpeg'],
			['image/gif', 'image/gif'], ['image/webp', 'image/webp'],
			['IMAGE/PNG', 'image/png'],            // 大写 + 归一
			['image/jpeg; charset=binary', 'image/jpeg'],   // 带参数（上游 baseMimeType）
		] as const) {
			const r = await processImage(PNG, input);
			expect(r.ok && r.mimeType, input).toBe(expected);
		}
	});

	it('非支持格式且没注入 photon：ok:false + 上游转换失败文案', async () => {
		const r = await processImage(PNG, 'image/bmp');
		expect(r).toEqual({ ok: false, message: '[Image omitted: could not be converted to a supported inline image format.]' });
	});
});

describe('processImage：注入 photon（上游路径）', () => {
	it('调用 resizeImage，参数逐字为 (bytes, mimeType, resizeOptions)', async () => {
		const photon = fakePhoton();
		const options = { maxWidth: 800, maxHeight: 600 };
		await processImage(PNG, 'image/png', { photon, resizeOptions: options });
		expect(photon.resizeImage).toHaveBeenCalledWith(PNG, 'image/png', options);
	});

	it('缩放成功：hints 含上游那句尺寸说明（模型据此把坐标映射回原图）', async () => {
		const r = await processImage(PNG, 'image/png', { photon: fakePhoton() });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.mimeType).toBe('image/jpeg');
		expect(r.data).toBe('BASE64');
		expect(r.hints).toEqual([
			'[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]',
		]);
	});

	it('未缩放（wasResized: false）→ 没有尺寸说明（上游同款）', async () => {
		const r = await processImage(PNG, 'image/png', {
			photon: fakePhoton({ resizeImage: vi.fn(async () => resized({ wasResized: false, data: 'B', mimeType: 'image/png' })) }),
		});
		expect(r.ok && r.hints).toEqual([]);
	});

	it('缩不到限内（resizeImage 返回 null）→ ok:false + 上游那句文案', async () => {
		const photon = fakePhoton({ resizeImage: vi.fn(async () => null) });
		const r = await processImage(PNG, 'image/png', { photon });
		expect(r).toEqual({ ok: false, message: '[Image omitted: could not be resized below the inline image size limit.]' });
	});

	it('autoResizeImages: false → 不调 resizeImage，原样 base64', async () => {
		const photon = fakePhoton();
		const r = await processImage(PNG, 'image/png', { photon, autoResizeImages: false });
		expect(photon.resizeImage).not.toHaveBeenCalled();
		expect(r.ok && r.data).toBe(btoa(String.fromCharCode(...PNG)));
	});

	it('非支持格式：先转 png 再缩放，hints 含转换提示（上游 conversionHint）', async () => {
		const photon = fakePhoton();
		const r = await processImage(PNG, 'image/bmp', { photon });
		expect(photon.convertImageBytesToPng).toHaveBeenCalledWith(PNG);
		expect(photon.resizeImage).toHaveBeenCalledWith(PNG, 'image/png', undefined);
		expect(r.ok && r.hints[0]).toBe('[Image converted from image/bmp to image/jpeg.]');
	});

	it('转换失败（convertImageBytesToPng 返回 null）→ ok:false + 转换失败文案', async () => {
		const photon = fakePhoton({ convertImageBytesToPng: vi.fn(async () => null) });
		const r = await processImage(PNG, 'image/bmp', { photon });
		expect(r).toEqual({ ok: false, message: '[Image omitted: could not be converted to a supported inline image format.]' });
		expect(photon.resizeImage).not.toHaveBeenCalled();
	});

	it('mimeType 带参数（image/jpeg; charset=x）归一后再走（上游 baseMimeType）', async () => {
		const photon = fakePhoton();
		await processImage(PNG, 'image/jpeg; charset=binary', { photon });
		expect(photon.resizeImage).toHaveBeenCalledWith(PNG, 'image/jpeg', undefined);
	});
});

describe('辅助：与上游逐字', () => {
	it('base64Length = ceil(n/3)*4（上游 image-resize-core.js:33）', () => {
		expect(base64Length(0)).toBe(0);
		expect(base64Length(1)).toBe(4);
		expect(base64Length(3)).toBe(4);
		expect(base64Length(4)).toBe(8);
	});

	it('formatDimensionNote 逐字（上游 image-resize.js:90-97）', () => {
		expect(formatDimensionNote(resized())).toBe(
			'[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]',
		);
		expect(formatDimensionNote(resized({ wasResized: false }))).toBeUndefined();
	});
});
