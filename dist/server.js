import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeResolve, generateShortCode, validateHmacSignature, formatRFC5987ContentDisposition, } from "./security.js";
import { resolveBaseUrl, parseFlexibleDuration, getDateMinuteSubdir, resolveGatewayBindHost } from "./config.js";
import { recordSeenHost } from "./domain.js";
import { renderErrorPage, renderUploadPage } from "./templates.js";
import { streamMultipartFiles, extractBoundary } from "./multipart.js";
// Comprehensive MIME type mapping
export const MIME_MAP = {
    // Web & Text
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".text": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonld": "application/ld+json",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8",
    ".bash": "text/plain; charset=utf-8",
    ".zsh": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".rs": "text/plain; charset=utf-8",
    ".go": "text/plain; charset=utf-8",
    ".c": "text/plain; charset=utf-8",
    ".cpp": "text/plain; charset=utf-8",
    ".h": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    // Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".avif": "image/avif",
    // Audio & Video
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    // Documents
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".epub": "application/epub+zip",
    // Archives
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".tgz": "application/gzip",
    ".zst": "application/zstd",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
    ".bz2": "application/x-bzip2",
    ".xz": "application/x-xz",
    // Binary & Generic
    ".bin": "application/octet-stream",
    ".exe": "application/octet-stream",
    ".dmg": "application/octet-stream",
    ".iso": "application/octet-stream",
    ".wasm": "application/wasm",
};
export function lookupMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    return MIME_MAP[ext] || "application/octet-stream";
}
export class FileserverServer {
    cfg;
    store;
    server = null;
    pruneTimer = null;
    constructor(cfg, store) {
        this.cfg = cfg;
        this.store = store;
    }
    getHttpServer() {
        return this.server;
    }
    start() {
        return new Promise((resolve, reject) => {
            const app = (req, res) => {
                this.securityHeadersMiddleware(res);
                try {
                    this.handleRequest(req, res);
                }
                catch (err) {
                    console.error("[openclaw-fileserver] Unhandled error:", err);
                    this.renderError(res, 500, "Internal Server Error", "An unexpected error occurred while processing the request");
                }
            };
            this.server = http.createServer(app);
            // Parse bind_addr (e.g. "0.0.0.0:8080", ":8080", "8080")
            // Resolves bind host dynamically from Gateway config instead of hardcoding 0.0.0.0
            let defaultHost = resolveGatewayBindHost(this.cfg.gateway);
            let port = 0;
            let host = defaultHost;
            if (this.cfg.bind_addr) {
                const trimmed = this.cfg.bind_addr.trim();
                if (trimmed.includes(":")) {
                    const parts = trimmed.split(":");
                    if (parts[0])
                        host = parts[0];
                    const p = parseInt(parts[1], 10);
                    if (!isNaN(p) && p > 0)
                        port = p;
                }
                else if (!isNaN(parseInt(trimmed, 10))) {
                    port = parseInt(trimmed, 10);
                }
                else if (trimmed && trimmed !== "none" && trimmed !== "disabled") {
                    host = trimmed;
                }
            }
            if (!port) {
                const envPort = process.env.FILESERVER_PORT || process.env.PORT;
                if (envPort) {
                    const p = parseInt(envPort, 10);
                    if (!isNaN(p) && p > 0)
                        port = p;
                }
            }
            this.server.listen(port, host, () => {
                console.log(`[openclaw-fileserver] Listening on ${host}:${port} (AllowedRoot: ${this.cfg.allowed_root})`);
                this.startBackgroundPruner();
                resolve();
            });
            this.server.on("error", (err) => {
                reject(err);
            });
        });
    }
    stop() {
        return new Promise((resolve) => {
            if (this.pruneTimer) {
                clearInterval(this.pruneTimer);
                this.pruneTimer = null;
            }
            if (this.server) {
                this.server.close(() => {
                    this.server = null;
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    startBackgroundPruner() {
        // Run every 1 hour, prune records expired > 24 hours
        this.pruneTimer = setInterval(() => {
            try {
                const { prunedShares, prunedUploads } = this.store.prune(24 * 3600 * 1000);
                if (prunedShares > 0 || prunedUploads > 0) {
                    console.log(`[openclaw-fileserver] Background prune cleaned ${prunedShares} shares, ${prunedUploads} uploads`);
                }
            }
            catch (err) {
                console.error("[openclaw-fileserver] Background prune error:", err);
            }
        }, 3600 * 1000);
    }
    securityHeadersMiddleware(res) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-XSS-Protection", "1; mode=block");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    }
    handleRequest(req, res) {
        this.securityHeadersMiddleware(res);
        const incomingHost = (req.headers["x-forwarded-host"] || req.headers.host);
        if (incomingHost) {
            recordSeenHost(incomingHost);
        }
        const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = parsedUrl.pathname;
        if (pathname === "/healthz") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok\n");
            return;
        }
        if (pathname.startsWith("/d/")) {
            this.handleDownload(req, res, parsedUrl);
            return;
        }
        if (pathname.startsWith("/uploads/")) {
            this.handleUploadPortal(req, res, parsedUrl);
            return;
        }
        if (pathname === "/api/share") {
            this.handleAPIShare(req, res, parsedUrl);
            return;
        }
        this.renderError(res, 404, "Not Found", "No matching service route found");
    }
    handleDownload(req, res, parsedUrl) {
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
        }
        const subPath = parsedUrl.pathname.slice(3); // remove '/d/'
        if (!subPath) {
            this.renderError(res, 404, "Not Found", "Download path is empty");
            return;
        }
        // Check legacy HMAC
        const sig = parsedUrl.searchParams.get("sig");
        const expiresStr = parsedUrl.searchParams.get("expires");
        if (sig && expiresStr) {
            this.handleLegacyDownload(req, res, subPath, sig, expiresStr, parsedUrl);
            return;
        }
        // Standard /d/<code>/<filename>
        const parts = subPath.split("/");
        const code = parts[0];
        const share = this.store.getShare(code);
        if (!share) {
            const uploadChannel = this.store.getUploadChannel(code);
            if (uploadChannel) {
                this.handleUploadChannelDownload(req, res, uploadChannel, parts, parsedUrl);
                return;
            }
            this.renderError(res, 404, "Not Found", "File share not found for the provided code");
            return;
        }
        if (share.revoked) {
            this.renderError(res, 410, "Gone", "This share link has been revoked by the owner");
            return;
        }
        if (new Date() > new Date(share.expires_at)) {
            this.renderError(res, 410, "Gone", "This share link has expired");
            return;
        }
        if (share.max_downloads > 0 && share.download_count >= share.max_downloads) {
            this.renderError(res, 410, "Gone", "Maximum download limit reached for this share");
            return;
        }
        let absPath;
        try {
            const resolved = safeResolve(this.cfg.allowed_root, share.file_path);
            absPath = resolved.absPath;
        }
        catch (err) {
            console.warn(`[openclaw-fileserver] Security sandbox violation for code ${code}:`, err);
            this.renderError(res, 403, "Forbidden", "Target file is outside the allowed sandbox");
            return;
        }
        if (!fs.existsSync(absPath)) {
            this.renderError(res, 404, "Not Found", "Target file not found on disk");
            return;
        }
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
            this.renderError(res, 403, "Forbidden", "Target path is a directory and cannot be downloaded directly");
            return;
        }
        let inline = share.inline;
        const qInline = parsedUrl.searchParams.get("inline");
        if (qInline !== null) {
            inline = qInline === "1" || qInline.toLowerCase() === "true";
        }
        // Check if initial fetch for download counting
        if (req.method === "GET") {
            const rangeHeader = req.headers.range;
            let isInitialFetch = false;
            if (!rangeHeader) {
                isInitialFetch = true;
            }
            else {
                const cleanRange = rangeHeader.trim();
                if (cleanRange.startsWith("bytes=0-") || cleanRange.startsWith("bytes=0/")) {
                    isInitialFetch = true;
                }
            }
            if (isInitialFetch) {
                try {
                    this.store.incrementDownloadCount(code);
                }
                catch (err) {
                    console.warn(`[openclaw-fileserver] Failed to increment download count for ${code}:`, err);
                }
            }
        }
        this.serveFileWithRange(req, res, absPath, share.filename, stat, inline);
    }
    handleLegacyDownload(req, res, relPath, sig, expiresStr, parsedUrl) {
        const expires = parseInt(expiresStr, 10);
        if (isNaN(expires)) {
            this.renderError(res, 400, "Bad Request", "Invalid expiration timestamp");
            return;
        }
        if (!this.cfg.secret_key) {
            this.renderError(res, 403, "Forbidden", "HMAC secret key is not configured");
            return;
        }
        if (!validateHmacSignature(this.cfg.secret_key, relPath, expires, sig)) {
            this.renderError(res, 403, "Forbidden", "Invalid or expired download signature");
            return;
        }
        let absPath;
        try {
            absPath = safeResolve(this.cfg.allowed_root, relPath).absPath;
        }
        catch {
            this.renderError(res, 403, "Forbidden", "Path is outside the allowed sandbox");
            return;
        }
        if (!fs.existsSync(absPath)) {
            this.renderError(res, 404, "Not Found", "File not found on disk");
            return;
        }
        const stat = fs.statSync(absPath);
        const filename = path.basename(absPath);
        const inline = parsedUrl.searchParams.get("inline") === "1";
        this.serveFileWithRange(req, res, absPath, filename, stat, inline);
    }
    handleUploadChannelDownload(req, res, channel, parts, parsedUrl) {
        if (channel.revoked) {
            this.renderError(res, 410, "Gone", "This channel has been revoked by the owner");
            return;
        }
        if (new Date() > new Date(channel.expires_at)) {
            this.renderError(res, 410, "Gone", "This channel has expired");
            return;
        }
        let reqFilename = "";
        if (parts.length > 1 && parts[1]) {
            reqFilename = parts[1];
        }
        else if (channel.files && channel.files.length > 0) {
            reqFilename = channel.files[channel.files.length - 1].filename;
        }
        else {
            this.renderError(res, 404, "Not Found", "No files uploaded to this channel yet");
            return;
        }
        let filePath = path.join(channel.target_dir, reqFilename);
        if (!fs.existsSync(filePath) && channel.files) {
            const matchFile = channel.files.find((f) => f.filename === reqFilename);
            if (matchFile && matchFile.rel_path) {
                filePath = path.join(this.cfg.allowed_root, matchFile.rel_path);
            }
        }
        let absPath;
        try {
            absPath = safeResolve(this.cfg.allowed_root, filePath).absPath;
        }
        catch {
            this.renderError(res, 403, "Forbidden", "Target file is outside the allowed sandbox");
            return;
        }
        if (!fs.existsSync(absPath)) {
            this.renderError(res, 404, "Not Found", "Target file not found on disk");
            return;
        }
        const stat = fs.statSync(absPath);
        const inline = parsedUrl.searchParams.get("inline") === "1";
        this.serveFileWithRange(req, res, absPath, reqFilename, stat, inline);
    }
    serveFileWithRange(req, res, absPath, filename, stat, inline) {
        const ext = path.extname(filename).toLowerCase();
        const contentType = MIME_MAP[ext] || "application/octet-stream";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", formatRFC5987ContentDisposition(inline, filename));
        res.setHeader("Cache-Control", "private, no-transform, max-age=300");
        res.setHeader("Accept-Ranges", "bytes");
        const totalSize = stat.size;
        const rangeHeader = req.headers.range;
        if (rangeHeader && req.method === "GET") {
            const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
            if (match) {
                let start = match[1] ? parseInt(match[1], 10) : NaN;
                let end = match[2] ? parseInt(match[2], 10) : NaN;
                if (isNaN(start) && !isNaN(end)) {
                    // suffix range, e.g. -500
                    start = totalSize - end;
                    end = totalSize - 1;
                }
                else if (!isNaN(start) && isNaN(end)) {
                    end = totalSize - 1;
                }
                if (!isNaN(start) && !isNaN(end) && start <= end && start >= 0 && end < totalSize) {
                    const chunkSize = end - start + 1;
                    res.writeHead(206, {
                        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
                        "Content-Length": chunkSize,
                    });
                    const stream = fs.createReadStream(absPath, { start, end });
                    stream.pipe(res);
                    return;
                }
                else {
                    res.writeHead(416, {
                        "Content-Range": `bytes */${totalSize}`,
                    });
                    res.end();
                    return;
                }
            }
        }
        res.writeHead(200, {
            "Content-Length": totalSize,
        });
        if (req.method === "HEAD") {
            res.end();
            return;
        }
        const stream = fs.createReadStream(absPath);
        stream.pipe(res);
    }
    async handleUploadPortal(req, res, parsedUrl) {
        const subPath = parsedUrl.pathname.slice(9); // remove '/uploads/'
        const parts = subPath.replace(/^\/+|\/+$/g, "").split("/");
        const code = parts[0];
        if (!code) {
            this.renderError(res, 404, "Not Found", "Invalid upload drop portal code");
            return;
        }
        const channel = this.store.getUploadChannel(code);
        if (!channel) {
            this.renderError(res, 404, "Not Found", "Upload channel does not exist or has been removed");
            return;
        }
        if (channel.revoked) {
            this.renderError(res, 410, "Gone", "This upload channel has been revoked by the owner");
            return;
        }
        if (new Date() > new Date(channel.expires_at)) {
            this.renderError(res, 410, "Gone", "This upload channel has expired");
            return;
        }
        if (channel.max_uploads > 0 && channel.upload_count >= channel.max_uploads) {
            this.renderError(res, 410, "Gone", "Upload limit reached for this channel");
            return;
        }
        if (req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderUploadPage(channel, this.cfg.max_upload_bytes));
            return;
        }
        if (req.method === "POST") {
            const contentType = req.headers["content-type"] || "";
            const boundary = extractBoundary(contentType);
            if (!boundary) {
                this.writeJSONError(res, 400, "Invalid form data: missing multipart boundary");
                return;
            }
            let absTargetDir;
            let relTargetDir;
            try {
                const resolved = safeResolve(this.cfg.allowed_root, channel.target_dir);
                absTargetDir = resolved.absPath;
                relTargetDir = resolved.relPath;
            }
            catch {
                this.writeJSONError(res, 403, "Target upload directory is outside the allowed sandbox");
                return;
            }
            let effectiveTargetDir = absTargetDir;
            let effectiveRelDir = relTargetDir;
            if (!/\d{4}[\/\-_]\d{2}[\/\-_]\d{2}/.test(channel.target_dir)) {
                const timeSub = getDateMinuteSubdir();
                effectiveTargetDir = path.join(absTargetDir, timeSub);
                effectiveRelDir = path.join(relTargetDir, timeSub);
            }
            if (!fs.existsSync(effectiveTargetDir)) {
                fs.mkdirSync(effectiveTargetDir, { recursive: true, mode: 0o750 });
            }
            try {
                const uploadedParts = await streamMultipartFiles(req, boundary, effectiveTargetDir, this.cfg.max_upload_bytes);
                const uploadedRecords = [];
                for (const part of uploadedParts) {
                    const relFile = path.join(effectiveRelDir, part.savedFilename).split(path.sep).join("/");
                    const rec = {
                        filename: part.savedFilename,
                        size: part.size,
                        uploaded_at: new Date().toISOString(),
                        rel_path: relFile,
                    };
                    this.store.recordUpload(channel.code, rec);
                    uploadedRecords.push(rec);
                    if (channel.max_uploads > 0 && channel.upload_count >= channel.max_uploads) {
                        break;
                    }
                }
                if (uploadedRecords.length === 0) {
                    this.writeJSONError(res, 400, "No valid files received");
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, files: uploadedRecords }));
            }
            catch (err) {
                console.error("[openclaw-fileserver] Upload stream error:", err);
                this.writeJSONError(res, 500, `Upload failed: ${err.message}`);
            }
            return;
        }
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
    }
    handleAPIShare(req, res, parsedUrl) {
        if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
        }
        // Verify token
        const authHeader = req.headers["authorization"] || "";
        const customHeader = (req.headers["x-api-token"] || "");
        let token = customHeader;
        if (!token && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
            token = authHeader.slice(7).trim();
        }
        if (this.cfg.api_token && token !== this.cfg.api_token) {
            this.writeJSONError(res, 401, "Unauthorized: invalid API token");
            return;
        }
        let bodyRaw = "";
        req.on("data", (chunk) => {
            bodyRaw += chunk;
            if (bodyRaw.length > 1024 * 1024) {
                req.destroy();
            }
        });
        req.on("end", () => {
            let payload;
            try {
                payload = JSON.parse(bodyRaw);
            }
            catch {
                this.writeJSONError(res, 400, "Invalid JSON payload");
                return;
            }
            if (!payload || !payload.path) {
                this.writeJSONError(res, 400, "Missing required parameter: path");
                return;
            }
            let absPath;
            let relPath;
            try {
                const resolved = safeResolve(this.cfg.allowed_root, payload.path);
                absPath = resolved.absPath;
                relPath = resolved.relPath;
            }
            catch (err) {
                this.writeJSONError(res, 403, `Sandbox check failed: ${err.message}`);
                return;
            }
            if (!fs.existsSync(absPath)) {
                this.writeJSONError(res, 404, "Target file does not exist");
                return;
            }
            const stat = fs.statSync(absPath);
            if (stat.isDirectory()) {
                this.writeJSONError(res, 400, "Target is a directory; only files can be shared");
                return;
            }
            let ttlMs = parseFlexibleDuration(this.cfg.default_ttl) || 24 * 3600 * 1000;
            if (payload.ttl) {
                const parsed = parseFlexibleDuration(payload.ttl);
                if (parsed > 0)
                    ttlMs = parsed;
            }
            const maxTtlMs = parseFlexibleDuration(this.cfg.max_ttl) || 168 * 3600 * 1000;
            if (ttlMs > maxTtlMs)
                ttlMs = maxTtlMs;
            const code = generateShortCode();
            const filename = path.basename(absPath);
            const record = {
                code,
                file_path: absPath,
                rel_path: relPath,
                filename,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + ttlMs).toISOString(),
                max_downloads: parseInt(payload.max_downloads, 10) || 0,
                download_count: 0,
                inline: !!payload.inline,
                revoked: false,
            };
            this.store.addShare(record);
            const downloadURL = `${resolveBaseUrl(this.cfg, req)}/${code}/${encodeURIComponent(filename)}`;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                ok: true,
                code,
                url: downloadURL,
                expires_at: record.expires_at,
            }));
        });
    }
    renderError(res, status, title, message) {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderErrorPage(status, title, message));
    }
    writeJSONError(res, status, message) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: message }));
    }
}
