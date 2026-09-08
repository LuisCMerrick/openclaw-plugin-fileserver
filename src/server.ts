import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { FileserverConfig } from "./types.js";
import { Store } from "./store.js";
import {
  safeResolve,
  generateShortCode,
  validateHmacSignature,
  formatRFC5987ContentDisposition,
} from "./security.js";
import { resolveBaseUrl, parseFlexibleDuration, getDateMinuteSubdir } from "./config.js";
import { recordSeenHost } from "./domain.js";
import { renderErrorPage, renderUploadPage } from "./templates.js";
import { streamMultipartFiles, extractBoundary } from "./multipart.js";

// Common mime type mapping
const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".zst": "application/zstd",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".bin": "application/octet-stream",
};

export class FileserverServer {
  private cfg: FileserverConfig;
  private store: Store;
  private server: http.Server | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(cfg: FileserverConfig, store: Store) {
    this.cfg = cfg;
    this.store = store;
  }

  public getHttpServer(): http.Server | null {
    return this.server;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const app = (req: http.IncomingMessage, res: http.ServerResponse) => {
        this.securityHeadersMiddleware(res);
        try {
          this.handleRequest(req, res);
        } catch (err: any) {
          console.error("[openclaw-fileserver] Unhandled error:", err);
          this.renderError(res, 500, "系统错误", "处理请求时发生内部异常");
        }
      };

      this.server = http.createServer(app);

      // Parse bind_addr (e.g. "0.0.0.0:18790", ":18790", "18790", "127.0.0.1:18790")
      let port = 18790;
      let host = "0.0.0.0";
      const parts = this.cfg.bind_addr.split(":");
      if (parts.length === 2) {
        if (parts[0]) host = parts[0];
        port = parseInt(parts[1]!, 10) || 18790;
      } else if (parts.length === 1 && !isNaN(parseInt(parts[0]!, 10))) {
        port = parseInt(parts[0]!, 10);
      }

      this.server.listen(port, host, () => {
        console.log(
          `[openclaw-fileserver] Listening on ${host}:${port} (AllowedRoot: ${this.cfg.allowed_root})`
        );
        this.startBackgroundPruner();
        resolve();
      });

      this.server.on("error", (err: any) => {
        reject(err);
      });
    });
  }

  public stop(): Promise<void> {
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
      } else {
        resolve();
      }
    });
  }

  private startBackgroundPruner(): void {
    // Run every 1 hour, prune records expired > 24 hours
    this.pruneTimer = setInterval(() => {
      try {
        const { prunedShares, prunedUploads } = this.store.prune(24 * 3600 * 1000);
        if (prunedShares > 0 || prunedUploads > 0) {
          console.log(
            `[openclaw-fileserver] Background prune cleaned ${prunedShares} shares, ${prunedUploads} uploads`
          );
        }
      } catch (err) {
        console.error("[openclaw-fileserver] Background prune error:", err);
      }
    }, 3600 * 1000);
  }

  private securityHeadersMiddleware(res: http.ServerResponse): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  }

  public handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.securityHeadersMiddleware(res);
    const incomingHost = (req.headers["x-forwarded-host"] || req.headers.host) as string | undefined;
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

    this.renderError(res, 404, "页面不存在", "未匹配到任何有效的服务路由");
  }

  private handleDownload(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    const subPath = parsedUrl.pathname.slice(3); // remove '/d/'
    if (!subPath) {
      this.renderError(res, 404, "文件不存在", "请求的下载路径为空");
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
    const code = parts[0]!;

    const share = this.store.getShare(code);
    if (!share) {
      const uploadChannel = this.store.getUploadChannel(code);
      if (uploadChannel) {
        this.handleUploadChannelDownload(req, res, uploadChannel, parts, parsedUrl);
        return;
      }
      this.renderError(res, 404, "分享不存在", "未找到该短码对应的文件分享");
      return;
    }

    if (share.revoked) {
      this.renderError(res, 410, "链接已被吊销", "该分享链接已被创建者主动撤销");
      return;
    }

    if (new Date() > new Date(share.expires_at)) {
      this.renderError(res, 410, "链接已过期", "该文件的分享有效期已截止");
      return;
    }

    if (share.max_downloads > 0 && share.download_count >= share.max_downloads) {
      this.renderError(res, 410, "下载次数已达上限", "该分享链接已达到最大允许下载次数");
      return;
    }

    let absPath: string;
    try {
      const resolved = safeResolve(this.cfg.allowed_root, share.file_path);
      absPath = resolved.absPath;
    } catch (err: any) {
      console.warn(`[openclaw-fileserver] Security sandbox violation for code ${code}:`, err);
      this.renderError(res, 403, "禁止访问", "目标文件超出安全沙箱范围");
      return;
    }

    if (!fs.existsSync(absPath)) {
      this.renderError(res, 404, "文件不存在", "磁盘上未找到目标文件");
      return;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      this.renderError(res, 403, "禁止访问", "目标路径为目录，不支持直接下载");
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
      } else {
        const cleanRange = rangeHeader.trim();
        if (cleanRange.startsWith("bytes=0-") || cleanRange.startsWith("bytes=0/")) {
          isInitialFetch = true;
        }
      }

      if (isInitialFetch) {
        try {
          this.store.incrementDownloadCount(code);
        } catch (err) {
          console.warn(`[openclaw-fileserver] Failed to increment download count for ${code}:`, err);
        }
      }
    }

    this.serveFileWithRange(req, res, absPath, share.filename, stat, inline);
  }

  private handleLegacyDownload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    relPath: string,
    sig: string,
    expiresStr: string,
    parsedUrl: URL
  ): void {
    const expires = parseInt(expiresStr, 10);
    if (isNaN(expires)) {
      this.renderError(res, 400, "参数错误", "无效的过期时间戳");
      return;
    }

    if (!this.cfg.secret_key) {
      this.renderError(res, 403, "功能未启用", "服务器未配置 HMAC 密钥");
      return;
    }

    if (!validateHmacSignature(this.cfg.secret_key, relPath, expires, sig)) {
      this.renderError(res, 403, "签名验证失败", "下载签名不匹配或已过期");
      return;
    }

    let absPath: string;
    try {
      absPath = safeResolve(this.cfg.allowed_root, relPath).absPath;
    } catch {
      this.renderError(res, 403, "禁止访问", "路径超出安全沙箱");
      return;
    }

    if (!fs.existsSync(absPath)) {
      this.renderError(res, 404, "文件不存在", "磁盘上未找到文件");
      return;
    }

    const stat = fs.statSync(absPath);
    const filename = path.basename(absPath);
    const inline = parsedUrl.searchParams.get("inline") === "1";

    this.serveFileWithRange(req, res, absPath, filename, stat, inline);
  }

  private handleUploadChannelDownload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    channel: any,
    parts: string[],
    parsedUrl: URL
  ): void {
    if (channel.revoked) {
      this.renderError(res, 410, "通道已撤销", "该通道已被创建者主动关闭");
      return;
    }
    if (new Date() > new Date(channel.expires_at)) {
      this.renderError(res, 410, "通道已过期", "该通道的有效期已截止");
      return;
    }

    let reqFilename = "";
    if (parts.length > 1 && parts[1]) {
      reqFilename = parts[1];
    } else if (channel.files && channel.files.length > 0) {
      reqFilename = channel.files[channel.files.length - 1].filename;
    } else {
      this.renderError(res, 404, "文件不存在", "该通道尚未接收到任何文件");
      return;
    }

    let filePath = path.join(channel.target_dir, reqFilename);
    if (!fs.existsSync(filePath) && channel.files) {
      const matchFile = channel.files.find((f: any) => f.filename === reqFilename);
      if (matchFile && matchFile.rel_path) {
        filePath = path.join(this.cfg.allowed_root, matchFile.rel_path);
      }
    }
    let absPath: string;
    try {
      absPath = safeResolve(this.cfg.allowed_root, filePath).absPath;
    } catch {
      this.renderError(res, 403, "禁止访问", "目标文件超出安全沙箱");
      return;
    }

    if (!fs.existsSync(absPath)) {
      this.renderError(res, 404, "文件不存在", "目标文件在磁盘上未找到");
      return;
    }

    const stat = fs.statSync(absPath);
    const inline = parsedUrl.searchParams.get("inline") === "1";

    this.serveFileWithRange(req, res, absPath, reqFilename, stat, inline);
  }

  private serveFileWithRange(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    absPath: string,
    filename: string,
    stat: fs.Stats,
    inline: boolean
  ): void {
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
        } else if (!isNaN(start) && isNaN(end)) {
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
        } else {
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

  private async handleUploadPortal(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
  ): Promise<void> {
    const subPath = parsedUrl.pathname.slice(9); // remove '/uploads/'
    const parts = subPath.replace(/^\/+|\/+$/g, "").split("/");
    const code = parts[0];

    if (!code) {
      this.renderError(res, 404, "通道不存在", "未指定有效的投递通道短码");
      return;
    }

    const channel = this.store.getUploadChannel(code);
    if (!channel) {
      this.renderError(res, 404, "投递通道不存在", "该上传通道未创建或已被移除");
      return;
    }

    if (channel.revoked) {
      this.renderError(res, 410, "投递通道已撤销", "该上传通道已被创建者主动关闭");
      return;
    }

    if (new Date() > new Date(channel.expires_at)) {
      this.renderError(res, 410, "投递通道已过期", "该上传通道的有效期已截止");
      return;
    }

    if (channel.max_uploads > 0 && channel.upload_count >= channel.max_uploads) {
      this.renderError(res, 410, "上传文件数已满", "该投递通道已达到最大允许上传文件总数");
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
        this.writeJSONError(res, 400, "无效的表单数据: 缺少 multipart boundary");
        return;
      }

      let absTargetDir: string;
      let relTargetDir: string;
      try {
        const resolved = safeResolve(this.cfg.allowed_root, channel.target_dir);
        absTargetDir = resolved.absPath;
        relTargetDir = resolved.relPath;
      } catch {
        this.writeJSONError(res, 403, "目标上传目录超出安全沙箱");
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
        const uploadedParts = await streamMultipartFiles(
          req,
          boundary,
          effectiveTargetDir,
          this.cfg.max_upload_bytes
        );

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
          this.writeJSONError(res, 400, "未接收到有效文件");
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, files: uploadedRecords }));
      } catch (err: any) {
        console.error("[openclaw-fileserver] Upload stream error:", err);
        this.writeJSONError(res, 500, `上传处理失败: ${err.message}`);
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
  }

  private handleAPIShare(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
  ): void {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    // Verify token
    const authHeader = req.headers["authorization"] || "";
    const customHeader = (req.headers["x-api-token"] || "") as string;
    let token = customHeader;
    if (!token && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }

    if (this.cfg.api_token && token !== this.cfg.api_token) {
      this.writeJSONError(res, 401, "Unauthorized: invalid API token");
      return;
    }

    let bodyRaw = "";
    req.on("data", (chunk: Buffer) => {
      bodyRaw += chunk;
      if (bodyRaw.length > 1024 * 1024) {
        req.destroy();
      }
    });

    req.on("end", () => {
      let payload: any;
      try {
        payload = JSON.parse(bodyRaw);
      } catch {
        this.writeJSONError(res, 400, "Invalid JSON payload");
        return;
      }

      if (!payload || !payload.path) {
        this.writeJSONError(res, 400, "Missing required parameter: path");
        return;
      }

      let absPath: string;
      let relPath: string;
      try {
        const resolved = safeResolve(this.cfg.allowed_root, payload.path);
        absPath = resolved.absPath;
        relPath = resolved.relPath;
      } catch (err: any) {
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
        if (parsed > 0) ttlMs = parsed;
      }
      const maxTtlMs = parseFlexibleDuration(this.cfg.max_ttl) || 168 * 3600 * 1000;
      if (ttlMs > maxTtlMs) ttlMs = maxTtlMs;

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
      res.end(
        JSON.stringify({
          ok: true,
          code,
          url: downloadURL,
          expires_at: record.expires_at,
        })
      );
    });
  }

  private renderError(res: http.ServerResponse, status: number, title: string, message: string): void {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage(status, title, message));
  }

  private writeJSONError(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}
