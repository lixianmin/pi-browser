// picomatch 4.0.7 不带类型声明。ambient `declare module` 只在本仓编译单元生效，
// 跨包消费（spice 直接编译本仓 src）会 TS7016——故集中收口：全仓只有这里允许无类型 import，
// 行为由 tools 测试锁定。上游若补类型，删 @ts-expect-error 与类型断言、改回直接导出即可。
// @ts-expect-error picomatch 未携带类型声明
import picomatch from 'picomatch';
export default picomatch;
