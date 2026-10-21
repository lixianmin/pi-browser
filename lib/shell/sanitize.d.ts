/** 删掉单 UTF-16 码元的不可打印控制字符（保留 `\t` `\n` `\r`；`\r` 的清除在调用方按需另做） */
export declare function sanitizeBinaryOutput(str: string): string;
