/** 上游 `image-resize-core.js:3` 的常量逐字：4.5MB base64 载荷，给 Anthropic 的 5MB 限制留余量。 */
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;
/** 上游 `image-resize-core.js:6-11` 的缺省选项逐字。 */
const DEFAULT_OPTIONS = {
    maxWidth: 2000,
    maxHeight: 2000,
    maxBytes: DEFAULT_MAX_BYTES,
    jpegQuality: 80,
};
const IMAGE_CONVERT_FAILED = '[Image omitted: could not be converted to a supported inline image format.]';
const IMAGE_TOO_LARGE = '[Image omitted: could not be resized below the inline image size limit.]';
function baseMimeType(mimeType) {
    return mimeType.split(';')[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}
/** 上游 `image-process.js:9-22` 逐字。 */
function normalizeSupportedImageMimeType(mimeType) {
    switch (baseMimeType(mimeType)) {
        case 'image/png': return 'image/png';
        case 'image/jpeg':
        case 'image/jpg': return 'image/jpeg';
        case 'image/gif': return 'image/gif';
        case 'image/webp': return 'image/webp';
        default: return null;
    }
}
/** 上游 `image-process.js:24-45` 逐字（`loadPhoton` 换成注入的 `convertImageBytesToPng`）。 */
async function normalizeImage(bytes, mimeType, photon) {
    const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
    if (normalizedMimeType)
        return { bytes, mimeType: normalizedMimeType };
    const pngBytes = photon ? await photon.convertImageBytesToPng(bytes) : null;
    if (!pngBytes)
        return null;
    return { bytes: pngBytes, mimeType: 'image/png', convertedFrom: baseMimeType(mimeType) };
}
/** 上游 `image-process.js:47-53` 逐字。 */
function conversionHint(from, to) {
    if (!from || from === to)
        return undefined;
    return `[Image converted from ${from} to ${to}.]`;
}
/** 上游 `image-resize.js:90-97` 逐字：告诉模型坐标怎么映射回原图。 */
export function formatDimensionNote(result) {
    if (!result.wasResized)
        return undefined;
    const scale = result.originalWidth / result.width;
    return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
/** base64 之后的长度（上游 `Math.ceil(n/3)*4`，逐字）；用于在**生成之前**判断要不要生成。 */
export function base64Length(byteLength) {
    return Math.ceil(byteLength / 3) * 4;
}
/** base64 编码；32768 字节/块展开，避免 `String.fromCharCode(...)` 的实参上限。 */
export function bytesToBase64(bytes) {
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
function passThroughWithinByteLimit(bytes, mimeType, options) {
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
export async function processImage(bytes, mimeType, options) {
    const autoResizeImages = options?.autoResizeImages ?? true;
    const normalized = await normalizeImage(bytes, mimeType, options?.photon);
    if (!normalized)
        return { ok: false, message: IMAGE_CONVERT_FAILED };
    if (autoResizeImages) {
        const resized = options?.photon
            ? await options.photon.resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions)
            : passThroughWithinByteLimit(normalized.bytes, normalized.mimeType, options?.resizeOptions);
        if (!resized)
            return { ok: false, message: IMAGE_TOO_LARGE };
        const hints = [];
        const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType);
        if (convertedHint)
            hints.push(convertedHint);
        const dimensionNote = formatDimensionNote(resized);
        if (dimensionNote)
            hints.push(dimensionNote);
        return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
    }
    const hints = [];
    const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
    if (convertedHint)
        hints.push(convertedHint);
    return { ok: true, data: bytesToBase64(normalized.bytes), mimeType: normalized.mimeType, hints };
}
