export interface PicomatchOptions {
    /** 匹配前导点文件（默认 false：与 bash glob 一致，`*` 不匹配 `.hidden`） */
    dot?: boolean;
    nocase?: boolean;
}
export type PicomatchMatcher = (input: string) => boolean;
export type PicomatchFactory = (pattern: string, options?: PicomatchOptions) => PicomatchMatcher;
declare const _default: PicomatchFactory;
export default _default;
