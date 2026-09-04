import type { ShareRecord, UploadChannel, UploadFileRecord } from "./types.js";
export declare class Store {
    private dataFile;
    private uploadDataFile;
    private shares;
    private uploads;
    private sharesModTime;
    private sharesSize;
    private uploadsModTime;
    private uploadsSize;
    constructor(dataFile: string, uploadDataFile: string);
    private ensureDirs;
    reload(): void;
    private checkSyncShares;
    private checkSyncUploads;
    addShare(rec: ShareRecord): void;
    getShare(code: string): ShareRecord | undefined;
    incrementDownloadCount(code: string): {
        newCount: number;
        reachedLimit: boolean;
    };
    addUploadChannel(channel: UploadChannel): void;
    getUploadChannel(code: string): UploadChannel | undefined;
    recordUpload(code: string, fileRecord: UploadFileRecord): {
        count: number;
        reachedLimit: boolean;
    };
    revoke(code: string): {
        revoked: boolean;
        kind: "share" | "upload" | "";
    };
    list(): {
        shares: ShareRecord[];
        uploads: UploadChannel[];
    };
    prune(gracePeriodMs?: number): {
        prunedShares: number;
        prunedUploads: number;
    };
}
