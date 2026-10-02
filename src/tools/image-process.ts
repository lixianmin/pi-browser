// src/tools/image-process.ts —— 图片处理（pi-coding-agent@1.0.0 的 `core/utils/image-*` 一族，浏览器版）。
//
// 出处与转写范围：
//   · `processImage`            ← `dist/utils/image-process.js`（82 行，逐字）
//   · `formatDimensionNote`     ← `dist/utils/image-resize.js:90-97`（逐字，纯格式化）
//   · `ImageResizeOptions` / `ResizedImage` ← `dist/utils/image-resize-core.d.ts`（逐字）
//   · 超限常量 4.5MB / 2000×2000 / jpegQuality 80 ← `dist/utils/image-resize-core.js:3-11`
//
// 唯一的结构性偏离（人类裁决 2026-10-02：能力与接口向 pi-coding-agent 对齐）：**像素活由宿主注入**。
// 上游 `loadPhoton()` 加载 `@silvia-odwyer/photon-node`，而那个包的 CJS 入口在模块加载时
// `require('fs').readFileSync(__dirname + '/photon_rs_bg.wasm')` —— 浏览器里根本没有 fs，包内也没有
// web 入口（`files` 只有那 5 个文件，`main` 指向 Node 入口）。所以 `ImagePhoton` 这个缝承接上游那两个
// 函数（`resizeImage` / `convertImageBytesToPng`），**名字与签名都用上游的**：宿主自己拿到 wasm 资源
// （fetch + WebAssembly.instantiate，或在 Worker 里，见 README）之后把实现绑进来即可，调用方零改。
// 与本仓既有缝同款（grep 的遍历 / find 的 glob / path-utils 的 access / bash 的 operations / wasi 的 workerUrl）。
//
// 未注入 photon 时的行为（刻意不抄上游的退化路径）：
//   上游缺 photon 时 `resizeImageInProcess` 在**「限内早退」之前**就返回 null（`image-resize-core.js:35-40`），
//   于是**连最小的图也会被整张丢掉**（`ok:false`）。我们只查 base64 字节上限：限内照常投递原字节，
//   超限才降级成上游那句说明。理由：那不是「与上游的差异」而是「宿主没装一个可选原生依赖」的副作用，
//   照抄它等于让所有不注入的浏览器宿主完全用不了图片；方向也比上游宽松（宁可多给）。
//   **仍存在的一截**：2000×2000 的尺寸降采样要 photon 才做得到（要先解码拿尺寸）——无 photon 时不做。
/** 上游 `ImageResizeOptions`（`image-resize-core.d.ts`，逐字）。 */
export type ImageResizeOptions = {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
};

/** 上游 `ResizedImage`（`image-resize-core.d.ts`，逐字）。 */
export interface ResizedImage {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

/**
 * 像素活缝：上游 `resizeImage`（`image-resize.js`）与 `convertImageBytesToPng`（`image-convert.js`）的签名。
 * 宿主用 photon（或任何等价实现）绑进来；`null` 的语义也与上游一致——「做不到」由上层转成 `ok:false`。
 */
export interface ImagePhoton {
	/** 缩到限内；缩不到（或没有该实现）返回 null。上游：把已超限/超尺寸的图缩到 `maxBytes` 以内。 */
	resizeImage(bytes: Uint8Array, mimeType: string, options?: ImageResizeOptions): Promise<ResizedImage | null>;
	/** 转成 png；不支持的格式或转换失败返回 null。 */
	convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null>;
}

/** 上游 `processImage` 的返回（`image-process.js`，逐字两分支）。 */
export type ProcessedImage =
	| { ok: true; data: string; mimeType: string; hints: string[] }
	| { ok: false; message: string };

/** `processImage` 的 options（上游 inline 形状：`autoResizeImages` + `resizeOptions`）。 */
export interface ProcessImageOptions {
	/** 缺省 true（上游 `image-process.js:43`） */
	autoResizeImages?: boolean;
	resizeOptions?: ImageResizeOptions;
	/** 像素活实现；缺省则只查 base64 字节上限（见文件头） */
	photon?: ImagePhoton;
}

/** 上游 `image-resize-core.js:3` 的常量逐字：4.5MB base64 载荷，给 Anthropic 的 5MB 限制留余量。 */
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

/** 上游 `image-resize-core.js:6-11` 的缺省选项逐字。 */
const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

const IMAGE_CONVERT_FAILED = '[Image omitted: could not be converted to a supported inline image format.]';
const IMAGE_TOO_LARGE = '[Image omitted: could not be resized below the inline image size limit.]';

function baseMimeType(mimeType: string): string {
	return mimeType.split(';')[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

/** 上游 `image-process.js:9-22` 逐字。 */
function normalizeSupportedImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case 'image/png': return 'image/png';
		case 'image/jpeg':
		case 'image/jpg': return 'image/jpeg';
		case 'image/gif': return 'image/gif';
		case 'image/webp': return 'image/webp';
		default: return null;
	}
}

interface NormalizedImage {
	bytes: Uint8Array;
	mimeType: string;
	convertedFrom?: string;
}

/** 上游 `image-process.js:24-45` 逐字（`loadPhoton` 换成注入的 `convertImageBytesToPng`）。 */
async function normalizeImage(
	bytes: Uint8Array,
	mimeType: string,
	photon: ImagePhoton | undefined,
): Promise<NormalizedImage | null> {
	const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
	if (normalizedMimeType) return { bytes, mimeType: normalizedMimeType };
	const pngBytes = photon ? await photon.convertImageBytesToPng(bytes) : null;
	if (!pngBytes) return null;
	return { bytes: pngBytes, mimeType: 'image/png', convertedFrom: baseMimeType(mimeType) };
}

/** 上游 `image-process.js:47-53` 逐字。 */
function conversionHint(from: string | undefined, to: string): string | undefined {
	if (!from || from === to) return undefined;
	return `[Image converted from ${from} to ${to}.]`;
}

/** 上游 `image-resize.js:90-97` 逐字：告诉模型坐标怎么映射回原图。 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) return undefined;
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

/** base64 之后的长度（上游 `Math.ceil(n/3)*4`，逐字）；用于在**生成之前**判断要不要生成。 */
export function base64Length(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}

/** base64 编码；32768 字节/块展开，避免 `String.fromCharCode(...)` 的实参上限。 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * 没有 photon 时的退化路径（上游 `image-resize-core.js:43-57`「限内早退」那一支的字节侧）。
 * 拿不到尺寸（要先解码），所以只查 base64 字节上限；返回形状与 `ResizedImage` 一致，
 * `wasResized: false`、尺寸用 0 占位（不会有 dimension note，因为没缩放过）。
 */
function passThroughWithinByteLimit(
	bytes: Uint8Array,
	mimeType: string,
	options: ImageResizeOptions | undefined,
): ResizedImage | null {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	if (base64Length(bytes.byteLength) < opts.maxBytes) {
		return {
			data: bytesToBase64(bytes),
			mimeType: mimeType || 'image/png',
			originalWidth: 0,
			originalHeight: 0,
			width: 0,
			height: 0,
			wasResized: false,
		};
	}
	return null;
}

/** 上游 `image-process.js:42-82` 逐字（`resizeImage` 换成注入的缝 + 无 photon 的退化分支）。 */
export async function processImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
): Promise<ProcessedImage> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized = await normalizeImage(bytes, mimeType, options?.photon);
	if (!normalized) return { ok: false, message: IMAGE_CONVERT_FAILED };

	if (autoResizeImages) {
		const resized = options?.photon
			? await options.photon.resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions)
			: passThroughWithinByteLimit(normalized.bytes, normalized.mimeType, options?.resizeOptions);
		if (!resized) return { ok: false, message: IMAGE_TOO_LARGE };
		const hints: string[] = [];
		const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType);
		if (convertedHint) hints.push(convertedHint);
		const dimensionNote = formatDimensionNote(resized);
		if (dimensionNote) hints.push(dimensionNote);
		return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
	}

	const hints: string[] = [];
	const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
	if (convertedHint) hints.push(convertedHint);
	return { ok: true, data: bytesToBase64(normalized.bytes), mimeType: normalized.mimeType, hints };
}
