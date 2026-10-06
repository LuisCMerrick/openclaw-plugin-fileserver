import * as http from "node:http";
import type { FileserverConfig } from "./types.js";
import { Store } from "./store.js";
export declare const MIME_MAP: Record<string, string>;
export declare function lookupMimeType(filename: string): string;
export declare class FileserverServer {
    private cfg;
    private store;
    private server;
    private pruneTimer;
    constructor(cfg: FileserverConfig, store: Store);
    getHttpServer(): http.Server | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    private startBackgroundPruner;
    private securityHeadersMiddleware;
    handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void;
    private handleDownload;
    private handleLegacyDownload;
    private handleUploadChannelDownload;
    private serveFileWithRange;
    private handleUploadPortal;
    private handleAPIShare;
    private renderError;
    private writeJSONError;
}
