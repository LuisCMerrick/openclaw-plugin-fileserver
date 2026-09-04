import type { UploadChannel } from "./types.js";
export declare function formatBytes(bytes: number): string;
export declare function renderErrorPage(status: number, title: string, message: string): string;
export declare function renderUploadPage(channel: UploadChannel, maxBytes: number): string;
