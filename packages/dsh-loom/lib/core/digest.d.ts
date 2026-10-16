export declare function canonicalize(value: unknown): unknown;
export declare function canonicalJson(value: unknown): string;
export declare function sha256Hex(text: string): string;
/** 内容摘要：先规范化再 sha256。 */
export declare function contentDigest(value: unknown): string;
export declare function shortDigest(value: unknown): string;
