// picomatch 4.0.7 不带类型声明（`files` 只有 index.js/posix.js/lib），本仓只用「pattern → 匹配函数」这一面。
// 自写最小声明而不是加 @types/picomatch：本批依赖增量只允许 picomatch（计划 Global Constraints）。
declare module 'picomatch' {
	export interface PicomatchOptions {
		/** 匹配前导点文件（默认 false：与 bash glob 一致，`*` 不匹配 `.hidden`） */
		dot?: boolean;
		nocase?: boolean;
	}
	export type PicomatchMatcher = (input: string) => boolean;
	export default function picomatch(pattern: string, options?: PicomatchOptions): PicomatchMatcher;
}
