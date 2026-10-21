/** Split a leading UTF-8 byte order mark from decoded text. */
export declare function splitBom(content: string): {
    bom: string;
    text: string;
};
