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
export type ProcessedImage = {
    ok: true;
    data: string;
    mimeType: string;
    hints: string[];
} | {
    ok: false;
    message: string;
};
/** `processImage` 的 options（上游 inline 形状：`autoResizeImages` + `resizeOptions`）。 */
export interface ProcessImageOptions {
    /** 缺省 true（上游 `image-process.js:43`） */
    autoResizeImages?: boolean;
    resizeOptions?: ImageResizeOptions;
    /** 像素活实现；缺省则只查 base64 字节上限（见文件头） */
    photon?: ImagePhoton;
}
/** 上游 `image-resize.js:90-97` 逐字：告诉模型坐标怎么映射回原图。 */
export declare function formatDimensionNote(result: ResizedImage): string | undefined;
/** base64 之后的长度（上游 `Math.ceil(n/3)*4`，逐字）；用于在**生成之前**判断要不要生成。 */
export declare function base64Length(byteLength: number): number;
/** base64 编码；32768 字节/块展开，避免 `String.fromCharCode(...)` 的实参上限。 */
export declare function bytesToBase64(bytes: Uint8Array): string;
/** 上游 `image-process.js:42-82` 逐字（`resizeImage` 换成注入的缝 + 无 photon 的退化分支）。 */
export declare function processImage(bytes: Uint8Array, mimeType: string, options?: ProcessImageOptions): Promise<ProcessedImage>;
