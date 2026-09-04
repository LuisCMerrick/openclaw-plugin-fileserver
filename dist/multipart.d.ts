import type { IncomingMessage } from "node:http";
export interface ParsedFilePart {
    originalFilename: string;
    savedFilename: string;
    savedAbsPath: string;
    size: number;
}
export declare function extractBoundary(contentType: string): string | null;
export declare function resolveUniqueFilename(dir: string, baseFilename: string): string;
/**
 * Parses multipart/form-data directly from request stream and pipes file parts to disk.
 * Memory overhead is negligible (< 128KB buffer) regardless of file size.
 */
export declare function streamMultipartFiles(req: IncomingMessage, boundary: string, targetDir: string, maxFileBytes: number): Promise<ParsedFilePart[]>;
