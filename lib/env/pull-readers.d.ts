import { type BinaryReader, type DirReader, type FileInfo } from '@earendil-works/pi-durable/env';
/**
 * 从**已读入内存的整份字节**建一个定位式二进制读取器（上游 `NodeBinaryReader` 的等价物）。
 *
 * `info()` 报的是**打开时**那份文件的元信息（上游契约：不报路径现在指向的东西），所以由调用方把
 * 打开瞬间的 `FileInfo` 传进来。
 */
export declare function createBinaryReader(bytes: Uint8Array, opened: FileInfo, path: string): BinaryReader;
/**
 * 从**已列好的一页条目**建目录分页读取器（上游 `DirReader` 的等价物）。
 *
 * 快照语义：`entries` 在 open 时给定，之后不重列。契约里的「条目在读元信息前消失就跳过」在快照下
 * 无从发生——浏览器侧的目录都很小，为此保留重列逻辑不划算（§2）。
 */
export declare function createDirReader(entries: FileInfo[], path: string): DirReader;
