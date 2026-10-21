import { type FileSystem } from '@earendil-works/pi-durable/env';
import type { MountEntry } from './types.js';
export interface MountTable extends FileSystem {
    /** 挂载顶层名（'/tmp' → 'tmp'；'/' 不入列），供 `listDir('/')` 合成挂载根 */
    roots(): string[];
}
export declare function createMountTable(entries: MountEntry[]): MountTable;
