// picomatch 4.0.7 不带类型声明。ambient `declare module` 只在本仓编译单元生效，
// 跨包消费（spice 直接编译本仓 src）会 TS7016——故集中收口：全仓只有这里允许无类型 import，
// 行为由 tools 测试锁定。上游若补类型，删 @ts-expect-error 与类型断言、改回直接导出即可。
// @ts-expect-error picomatch 未携带类型声明
import picomatch from 'picomatch';

export interface PicomatchOptions {
	/** 匹配前导点文件（默认 false：与 bash glob 一致，`*` 不匹配 `.hidden`） */
	dot?: boolean;
	nocase?: boolean;
}
export type PicomatchMatcher = (input: string) => boolean;
export type PicomatchFactory = (pattern: string, options?: PicomatchOptions) => PicomatchMatcher;

export default picomatch as unknown as PicomatchFactory;
