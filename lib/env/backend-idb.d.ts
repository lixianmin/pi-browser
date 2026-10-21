import type { BrowserFileSystem } from './types.js';
/** 测试专用逃生口：清空内核注册表——「同库新实例」durability 类测试清表后重开，断言的才是 IDB 落盘本身
 *  （否则命中同内核恒绿、不再测落盘）。先例：debugger handler.ts `resetHandlerCache()`。生产代码禁用。 */
export declare function resetFsKernelRegistry(): void;
export interface BrowserFileSystemOptions {
    /** IndexedDB 库名（浏览器）/ 锁名前缀（Node）；默认 'spice-sessions'。**同 dbName 共享同一内核**（注册表）。 */
    dbName?: string;
    /** pi `FileSystem.cwd`（相对路径解析基准）；默认 '/'。**cwd 不进注册表 key**——同库多 cwd 视图必须同世界。 */
    cwd?: string;
    /** 强制内存后端：**每调用独立纯内存世界**（createMemoryFileSystem），与注册表零交互（不查表/不写表/不缓存，
     *  任意两次 memory:true 调用彼此也是独立世界）——测试/开发的隔离旋钮。
     *  不传时：有 IndexedDB 走持久内核，无则自动内存（两者都入注册表，同 dbName 同世界）；
     *  `memory: false` = 只用注册表内核（同 dbName 同世界；有 indexedDB 时是 IDB 内核，无 indexedDB 时是
     *  MemoryBackend 内核——与旧「强制 IDB 再自愈」对外等价，配 fake-indexeddb 可测真 IDB 路径）。 */
    memory?: boolean;
}
/** 落 lightning-fs 的文件系统能力（pi FileSystem 契约）。Node/单测走纯内存实现（自愈与该判据同源） */
export declare function createBrowserFileSystem(o?: BrowserFileSystemOptions): BrowserFileSystem;
