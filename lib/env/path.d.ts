/** 归一化为 '/'-根绝对路径（纯 JS，无 node:path——本包浏览器/Node 同构） */
export declare function normalizePath(p: string): string;
/** 取父目录（纯 JS，node:path `dirname` 的浏览器替身）。根目录的父目录仍是 `/`。 */
export declare function dirname(p: string): string;
