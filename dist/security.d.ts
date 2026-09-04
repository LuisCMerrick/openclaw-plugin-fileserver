export declare const ShortCodeCharset = "23456789abcdefghjkmnpqrstuvwxyz";
export declare const ShortCodeLength = 8;
export declare function generateShortCode(): string;
export declare function safeResolve(allowedRoot: string, userPath: string): {
    absPath: string;
    relPath: string;
};
export declare function sanitizeFilename(raw: string): string;
export declare function generateHmacSignature(secretKey: string, relPath: string, expires: number): string;
export declare function validateHmacSignature(secretKey: string, relPath: string, expires: number, expectedSig: string): boolean;
export declare function formatRFC5987ContentDisposition(inline: boolean, filename: string): string;
