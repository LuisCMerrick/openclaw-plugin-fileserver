import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeFilename } from "./security.js";
export function extractBoundary(contentType) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!match)
        return null;
    return (match[1] || match[2] || "").trim();
}
export function resolveUniqueFilename(dir, baseFilename) {
    const target = path.join(dir, baseFilename);
    if (!fs.existsSync(target)) {
        return baseFilename;
    }
    const ext = path.extname(baseFilename);
    const nameWithoutExt = path.basename(baseFilename, ext);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    let candidate = `${nameWithoutExt}_${timestamp}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) {
        return candidate;
    }
    for (let i = 1; i <= 100; i++) {
        candidate = `${nameWithoutExt}_${timestamp}_${i}${ext}`;
        if (!fs.existsSync(path.join(dir, candidate))) {
            return candidate;
        }
    }
    return candidate;
}
/**
 * Parses multipart/form-data directly from request stream and pipes file parts to disk.
 * Memory overhead is negligible (< 128KB buffer) regardless of file size.
 */
export async function streamMultipartFiles(req, boundary, targetDir, maxFileBytes) {
    const boundaryDelimiter = Buffer.from(`--${boundary}`);
    const boundaryDelimiterWithPrefix = Buffer.from(`\r\n--${boundary}`);
    const headerEndDelimiter = Buffer.from(`\r\n\r\n`);
    const uploadedFiles = [];
    let state = "SEEK_INITIAL_BOUNDARY";
    let buf = Buffer.alloc(0);
    let currentFileStream = null;
    let currentFileBytes = 0;
    let currentOriginalName = "";
    let currentSavedName = "";
    let currentSavedAbsPath = "";
    return new Promise((resolve, reject) => {
        let totalBytesRead = 0;
        let isTerminated = false;
        const cleanupCurrentFile = () => {
            if (currentFileStream) {
                try {
                    currentFileStream.destroy();
                }
                catch { }
                currentFileStream = null;
                if (currentSavedAbsPath && fs.existsSync(currentSavedAbsPath)) {
                    try {
                        fs.unlinkSync(currentSavedAbsPath);
                    }
                    catch { }
                }
            }
        };
        const fail = (err) => {
            if (isTerminated)
                return;
            isTerminated = true;
            cleanupCurrentFile();
            reject(err);
        };
        req.on("data", (chunk) => {
            if (isTerminated)
                return;
            totalBytesRead += chunk.length;
            if (totalBytesRead > maxFileBytes) {
                fail(new Error(`Payload size exceeded limit of ${maxFileBytes} bytes`));
                return;
            }
            buf = Buffer.concat([buf, chunk]);
            processBuffer();
        });
        req.on("end", () => {
            if (isTerminated)
                return;
            if (currentFileStream) {
                currentFileStream.end(() => {
                    uploadedFiles.push({
                        originalFilename: currentOriginalName,
                        savedFilename: currentSavedName,
                        savedAbsPath: currentSavedAbsPath,
                        size: currentFileBytes,
                    });
                    resolve(uploadedFiles);
                });
            }
            else {
                resolve(uploadedFiles);
            }
        });
        req.on("error", (err) => {
            fail(err);
        });
        function processBuffer() {
            while (!isTerminated) {
                if (state === "SEEK_INITIAL_BOUNDARY") {
                    const idx = buf.indexOf(boundaryDelimiter);
                    if (idx === -1) {
                        // Keep at most delimiter length to avoid losing boundary
                        if (buf.length > boundaryDelimiter.length * 2) {
                            buf = buf.subarray(buf.length - boundaryDelimiter.length * 2);
                        }
                        break;
                    }
                    buf = buf.subarray(idx + boundaryDelimiter.length);
                    // Consume trailing \r\n if present
                    if (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) {
                        buf = buf.subarray(2);
                    }
                    state = "READ_HEADERS";
                }
                else if (state === "READ_HEADERS") {
                    const idx = buf.indexOf(headerEndDelimiter);
                    if (idx === -1) {
                        break;
                    }
                    const headersRaw = buf.subarray(0, idx).toString("utf-8");
                    buf = buf.subarray(idx + headerEndDelimiter.length);
                    // Parse Content-Disposition
                    const dispositionMatch = /content-disposition:\s*form-data;\s*([^;\r\n]+)(?:;\s*filename="([^"]*)")?/i.exec(headersRaw);
                    let filename;
                    if (dispositionMatch && dispositionMatch[2] !== undefined) {
                        filename = dispositionMatch[2];
                    }
                    else {
                        // Also try filename*=UTF-8''...
                        const utfMatch = /filename\*=UTF-8''([^;\r\n]+)/i.exec(headersRaw);
                        if (utfMatch && utfMatch[1]) {
                            try {
                                filename = decodeURIComponent(utfMatch[1]);
                            }
                            catch {
                                filename = utfMatch[1];
                            }
                        }
                    }
                    if (filename) {
                        currentOriginalName = filename;
                        const safeName = sanitizeFilename(filename);
                        currentSavedName = resolveUniqueFilename(targetDir, safeName);
                        currentSavedAbsPath = path.join(targetDir, currentSavedName);
                        try {
                            currentFileStream = fs.createWriteStream(currentSavedAbsPath, {
                                flags: "wx",
                                mode: 0o640,
                            });
                            currentFileBytes = 0;
                        }
                        catch (err) {
                            fail(new Error(`Failed to create target file ${currentSavedAbsPath}: ${err.message}`));
                            return;
                        }
                    }
                    else {
                        currentFileStream = null;
                    }
                    state = "STREAM_BODY";
                }
                else if (state === "STREAM_BODY") {
                    const idx = buf.indexOf(boundaryDelimiterWithPrefix);
                    if (idx !== -1) {
                        // Part finished
                        const fileData = buf.subarray(0, idx);
                        if (currentFileStream) {
                            currentFileStream.write(fileData);
                            currentFileBytes += fileData.length;
                            currentFileStream.end();
                            uploadedFiles.push({
                                originalFilename: currentOriginalName,
                                savedFilename: currentSavedName,
                                savedAbsPath: currentSavedAbsPath,
                                size: currentFileBytes,
                            });
                            currentFileStream = null;
                        }
                        // Move past boundary
                        buf = buf.subarray(idx + boundaryDelimiterWithPrefix.length);
                        // Check if final boundary --
                        if (buf.length >= 2 && buf[0] === 0x2d && buf[1] === 0x2d) {
                            // '--' found, end of multipart
                            isTerminated = true;
                            resolve(uploadedFiles);
                            return;
                        }
                        if (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) {
                            buf = buf.subarray(2);
                        }
                        state = "READ_HEADERS";
                    }
                    else {
                        // No boundary in current buffer.
                        // Flush all but the last boundaryDelimiterWithPrefix.length bytes
                        const safeLength = buf.length - (boundaryDelimiterWithPrefix.length + 4);
                        if (safeLength > 0) {
                            const toWrite = buf.subarray(0, safeLength);
                            if (currentFileStream) {
                                currentFileStream.write(toWrite);
                                currentFileBytes += toWrite.length;
                            }
                            buf = buf.subarray(safeLength);
                        }
                        break;
                    }
                }
            }
        }
    });
}
