import * as fs from "node:fs";
import * as path from "node:path";
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function withFileLockSync(lockFilePath, fn) {
    const maxRetries = 100;
    const retryIntervalMs = 20;
    let fd = null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            fd = fs.openSync(lockFilePath, "wx");
            break;
        }
        catch (err) {
            if (err.code === "EEXIST") {
                // Check for stale lock (> 10s)
                try {
                    const stat = fs.statSync(lockFilePath);
                    if (Date.now() - stat.mtimeMs > 10000) {
                        try {
                            fs.unlinkSync(lockFilePath);
                        }
                        catch {
                            // ignore race
                        }
                    }
                }
                catch {
                    // lock was just removed
                }
                // Busy wait synchronous sleep
                const end = Date.now() + retryIntervalMs;
                while (Date.now() < end) { }
            }
            else {
                throw err;
            }
        }
    }
    if (fd === null) {
        throw new Error(`Failed to acquire lock on ${lockFilePath} within timeout`);
    }
    try {
        return fn();
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch {
            // ignore
        }
        try {
            fs.unlinkSync(lockFilePath);
        }
        catch {
            // ignore
        }
    }
}
function atomicWriteJsonSync(filePath, data) {
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, jsonStr, { mode: 0o600, encoding: "utf-8" });
    fs.renameSync(tmpPath, filePath);
}
function readSharesFromDisk(filePath) {
    if (!fs.existsSync(filePath)) {
        return { map: new Map(), mtimeMs: 0, size: 0 };
    }
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
        return { map: new Map(), mtimeMs: stat.mtimeMs, size: stat.size };
    }
    const list = JSON.parse(raw);
    const map = new Map();
    for (const item of list) {
        if (item.code) {
            map.set(item.code, item);
        }
    }
    return { map, mtimeMs: stat.mtimeMs, size: stat.size };
}
function readUploadsFromDisk(filePath) {
    if (!fs.existsSync(filePath)) {
        return { map: new Map(), mtimeMs: 0, size: 0 };
    }
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
        return { map: new Map(), mtimeMs: stat.mtimeMs, size: stat.size };
    }
    const list = JSON.parse(raw);
    const map = new Map();
    for (const item of list) {
        if (item.code) {
            if (!Array.isArray(item.files)) {
                item.files = [];
            }
            map.set(item.code, item);
        }
    }
    return { map, mtimeMs: stat.mtimeMs, size: stat.size };
}
export class Store {
    dataFile;
    uploadDataFile;
    shares = new Map();
    uploads = new Map();
    sharesModTime = 0;
    sharesSize = 0;
    uploadsModTime = 0;
    uploadsSize = 0;
    constructor(dataFile, uploadDataFile) {
        this.dataFile = path.resolve(dataFile);
        this.uploadDataFile = path.resolve(uploadDataFile);
        this.ensureDirs();
        this.reload();
    }
    ensureDirs() {
        const d1 = path.dirname(this.dataFile);
        if (!fs.existsSync(d1)) {
            fs.mkdirSync(d1, { recursive: true, mode: 0o750 });
        }
        const d2 = path.dirname(this.uploadDataFile);
        if (!fs.existsSync(d2)) {
            fs.mkdirSync(d2, { recursive: true, mode: 0o750 });
        }
    }
    reload() {
        const sharesLock = `${this.dataFile}.lock`;
        withFileLockSync(sharesLock, () => {
            const { map, mtimeMs, size } = readSharesFromDisk(this.dataFile);
            this.shares = map;
            this.sharesModTime = mtimeMs;
            this.sharesSize = size;
        });
        const uploadLock = `${this.uploadDataFile}.lock`;
        withFileLockSync(uploadLock, () => {
            const { map, mtimeMs, size } = readUploadsFromDisk(this.uploadDataFile);
            this.uploads = map;
            this.uploadsModTime = mtimeMs;
            this.uploadsSize = size;
        });
    }
    checkSyncShares() {
        if (!fs.existsSync(this.dataFile))
            return;
        try {
            const stat = fs.statSync(this.dataFile);
            if (stat.mtimeMs !== this.sharesModTime || stat.size !== this.sharesSize) {
                const sharesLock = `${this.dataFile}.lock`;
                withFileLockSync(sharesLock, () => {
                    const { map, mtimeMs, size } = readSharesFromDisk(this.dataFile);
                    this.shares = map;
                    this.sharesModTime = mtimeMs;
                    this.sharesSize = size;
                });
            }
        }
        catch {
            // ignore
        }
    }
    checkSyncUploads() {
        if (!fs.existsSync(this.uploadDataFile))
            return;
        try {
            const stat = fs.statSync(this.uploadDataFile);
            if (stat.mtimeMs !== this.uploadsModTime || stat.size !== this.uploadsSize) {
                const uploadLock = `${this.uploadDataFile}.lock`;
                withFileLockSync(uploadLock, () => {
                    const { map, mtimeMs, size } = readUploadsFromDisk(this.uploadDataFile);
                    this.uploads = map;
                    this.uploadsModTime = mtimeMs;
                    this.uploadsSize = size;
                });
            }
        }
        catch {
            // ignore
        }
    }
    addShare(rec) {
        const sharesLock = `${this.dataFile}.lock`;
        withFileLockSync(sharesLock, () => {
            const { map } = readSharesFromDisk(this.dataFile);
            map.set(rec.code, rec);
            const list = Array.from(map.values());
            atomicWriteJsonSync(this.dataFile, list);
            try {
                const stat = fs.statSync(this.dataFile);
                this.sharesModTime = stat.mtimeMs;
                this.sharesSize = stat.size;
            }
            catch {
                // ignore
            }
            this.shares = map;
        });
    }
    getShare(code) {
        this.checkSyncShares();
        const rec = this.shares.get(code);
        return rec ? { ...rec } : undefined;
    }
    incrementDownloadCount(code) {
        const sharesLock = `${this.dataFile}.lock`;
        return withFileLockSync(sharesLock, () => {
            const { map } = readSharesFromDisk(this.dataFile);
            const rec = map.get(code);
            if (!rec) {
                throw new Error("share not found");
            }
            rec.download_count = (rec.download_count || 0) + 1;
            const reachedLimit = rec.max_downloads > 0 && rec.download_count >= rec.max_downloads;
            const list = Array.from(map.values());
            atomicWriteJsonSync(this.dataFile, list);
            try {
                const stat = fs.statSync(this.dataFile);
                this.sharesModTime = stat.mtimeMs;
                this.sharesSize = stat.size;
            }
            catch {
                // ignore
            }
            this.shares = map;
            return { newCount: rec.download_count, reachedLimit };
        });
    }
    addUploadChannel(channel) {
        const uploadLock = `${this.uploadDataFile}.lock`;
        withFileLockSync(uploadLock, () => {
            const { map } = readUploadsFromDisk(this.uploadDataFile);
            map.set(channel.code, channel);
            const list = Array.from(map.values());
            atomicWriteJsonSync(this.uploadDataFile, list);
            try {
                const stat = fs.statSync(this.uploadDataFile);
                this.uploadsModTime = stat.mtimeMs;
                this.uploadsSize = stat.size;
            }
            catch {
                // ignore
            }
            this.uploads = map;
        });
    }
    getUploadChannel(code) {
        this.checkSyncUploads();
        const ch = this.uploads.get(code);
        if (!ch)
            return undefined;
        return {
            ...ch,
            files: (ch.files || []).map((f) => ({ ...f })),
        };
    }
    recordUpload(code, fileRecord) {
        const uploadLock = `${this.uploadDataFile}.lock`;
        return withFileLockSync(uploadLock, () => {
            const { map } = readUploadsFromDisk(this.uploadDataFile);
            const ch = map.get(code);
            if (!ch) {
                throw new Error("upload channel not found");
            }
            ch.upload_count = (ch.upload_count || 0) + 1;
            if (!Array.isArray(ch.files))
                ch.files = [];
            ch.files.push(fileRecord);
            const reachedLimit = ch.max_uploads > 0 && ch.upload_count >= ch.max_uploads;
            const list = Array.from(map.values());
            atomicWriteJsonSync(this.uploadDataFile, list);
            try {
                const stat = fs.statSync(this.uploadDataFile);
                this.uploadsModTime = stat.mtimeMs;
                this.uploadsSize = stat.size;
            }
            catch {
                // ignore
            }
            this.uploads = map;
            return { count: ch.upload_count, reachedLimit };
        });
    }
    revoke(code) {
        const sharesLock = `${this.dataFile}.lock`;
        let revokedShare = false;
        withFileLockSync(sharesLock, () => {
            const { map } = readSharesFromDisk(this.dataFile);
            const rec = map.get(code);
            if (rec) {
                rec.revoked = true;
                atomicWriteJsonSync(this.dataFile, Array.from(map.values()));
                this.shares = map;
                revokedShare = true;
            }
        });
        if (revokedShare) {
            return { revoked: true, kind: "share" };
        }
        const uploadLock = `${this.uploadDataFile}.lock`;
        let revokedUpload = false;
        withFileLockSync(uploadLock, () => {
            const { map } = readUploadsFromDisk(this.uploadDataFile);
            const ch = map.get(code);
            if (ch) {
                ch.revoked = true;
                atomicWriteJsonSync(this.uploadDataFile, Array.from(map.values()));
                this.uploads = map;
                revokedUpload = true;
            }
        });
        if (revokedUpload) {
            return { revoked: true, kind: "upload" };
        }
        return { revoked: false, kind: "" };
    }
    list() {
        this.checkSyncShares();
        this.checkSyncUploads();
        const shares = Array.from(this.shares.values()).map((s) => ({ ...s }));
        const uploads = Array.from(this.uploads.values()).map((u) => ({
            ...u,
            files: (u.files || []).map((f) => ({ ...f })),
        }));
        return { shares, uploads };
    }
    prune(gracePeriodMs = 0) {
        const now = Date.now();
        let prunedShares = 0;
        let prunedUploads = 0;
        const sharesLock = `${this.dataFile}.lock`;
        withFileLockSync(sharesLock, () => {
            const { map } = readSharesFromDisk(this.dataFile);
            const newMap = new Map();
            for (const [code, rec] of map.entries()) {
                const exp = new Date(rec.expires_at).getTime() + gracePeriodMs;
                const isExhausted = rec.max_downloads > 0 && rec.download_count >= rec.max_downloads;
                if (rec.revoked || now > exp || isExhausted) {
                    prunedShares++;
                }
                else {
                    newMap.set(code, rec);
                }
            }
            if (prunedShares > 0) {
                atomicWriteJsonSync(this.dataFile, Array.from(newMap.values()));
                this.shares = newMap;
            }
        });
        const uploadLock = `${this.uploadDataFile}.lock`;
        withFileLockSync(uploadLock, () => {
            const { map } = readUploadsFromDisk(this.uploadDataFile);
            const newMap = new Map();
            for (const [code, ch] of map.entries()) {
                const exp = new Date(ch.expires_at).getTime() + gracePeriodMs;
                const isExhausted = ch.max_uploads > 0 && ch.upload_count >= ch.max_uploads;
                if (ch.revoked || now > exp || isExhausted) {
                    prunedUploads++;
                }
                else {
                    newMap.set(code, ch);
                }
            }
            if (prunedUploads > 0) {
                atomicWriteJsonSync(this.uploadDataFile, Array.from(newMap.values()));
                this.uploads = newMap;
            }
        });
        return { prunedShares, prunedUploads };
    }
}
