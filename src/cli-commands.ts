import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig, resolveBaseUrl, resolveUploadBaseUrl, parseFlexibleDuration, resolveUploadTargetDir } from "./config.js";
import { Store } from "./store.js";
import { safeResolve, generateShortCode } from "./security.js";
import { formatBytes } from "./templates.js";
import type { ShareRecord, UploadChannel } from "./types.js";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  let s = Math.round(ms / 1000);
  const days = Math.floor(s / 86400);
  s %= 86400;
  const hours = Math.floor(s / 3600);
  s %= 3600;
  const mins = Math.floor(s / 60);
  s %= 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

export async function cliShare(filePath: string, options: { ttl?: string; max?: string | number; inline?: boolean; domain?: string; config?: string }): Promise<void> {
  if (!filePath) {
    console.error("Error: file path is required");
    process.exit(1);
  }

  const cfg = loadConfig(options.config);
  const store = new Store(cfg.data_file, cfg.upload_data_file);

  let absPath = "";
  let relPath = "";
  try {
    const resolved = safeResolve(cfg.allowed_root, filePath);
    absPath = resolved.absPath;
    relPath = resolved.relPath;
  } catch (err: any) {
    console.error("Security check failed:", err.message);
    process.exit(1);
  }

  if (!fs.existsSync(absPath)) {
    console.error("File not found:", absPath);
    process.exit(1);
  }

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    console.error("Cannot share a directory; must be a regular file");
    process.exit(1);
  }

  let ttlMs = parseFlexibleDuration(cfg.default_ttl) || 24 * 3600 * 1000;
  if (options.ttl) {
    const parsed = parseFlexibleDuration(options.ttl);
    if (parsed > 0) ttlMs = parsed;
  }
  const maxTtlMs = parseFlexibleDuration(cfg.max_ttl) || 168 * 3600 * 1000;
  if (ttlMs > maxTtlMs) ttlMs = maxTtlMs;

  const maxDownloads = typeof options.max === "string" ? parseInt(options.max, 10) : typeof options.max === "number" ? options.max : 0;
  const inline = !!options.inline;

  const code = generateShortCode();
  const filename = path.basename(absPath);
  const expiresDate = new Date(Date.now() + ttlMs);

  const record: ShareRecord = {
    code,
    file_path: absPath,
    rel_path: relPath,
    filename,
    created_at: new Date().toISOString(),
    expires_at: expiresDate.toISOString(),
    max_downloads: maxDownloads,
    download_count: 0,
    inline,
    revoked: false,
  };

  store.addShare(record);

  let baseURL = resolveBaseUrl(cfg);
  if (options.domain) {
    const dom = options.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    baseURL = `https://${dom}/d`;
  }
  const downloadURL = `${baseURL}/${code}/${encodeURIComponent(filename)}`;

  console.log("File Share Created Successfully:");
  console.log(`  Code:        ${code}`);
  console.log(`  URL:         ${downloadURL}`);
  console.log(`  File:        ${filename} (${formatBytes(stat.size)})`);
  console.log(`  Workspace:   ${relPath}`);
  console.log(`  Expires:     ${expiresDate.toLocaleString()} (in ${formatRemaining(ttlMs)})`);
  if (maxDownloads > 0) {
    console.log(`  Max Downloads: ${maxDownloads}`);
  } else {
    console.log(`  Max Downloads: Unlimited`);
  }
  if (inline) {
    console.log(`  Mode:        Inline Preview`);
  }
}

export async function cliReceive(options: { dir?: string; ttl?: string; max?: string | number; domain?: string; config?: string }): Promise<void> {
  const cfg = loadConfig(options.config);
  const store = new Store(cfg.data_file, cfg.upload_data_file);

  const targetDirFlag = resolveUploadTargetDir(options.dir);
  let destDir = targetDirFlag;
  if (!path.isAbsolute(destDir)) {
    destDir = path.join(cfg.allowed_root, destDir);
  }

  let absDir = "";
  let relDir = "";
  try {
    const resolved = safeResolve(cfg.allowed_root, destDir);
    absDir = resolved.absPath;
    relDir = resolved.relPath;
  } catch (err: any) {
    console.error("Security check failed on target directory:", err.message);
    process.exit(1);
  }

  if (!fs.existsSync(absDir)) {
    fs.mkdirSync(absDir, { recursive: true, mode: 0o750 });
  }

  let ttlMs = parseFlexibleDuration(cfg.default_ttl) || 24 * 3600 * 1000;
  if (options.ttl) {
    const parsed = parseFlexibleDuration(options.ttl);
    if (parsed > 0) ttlMs = parsed;
  }
  const maxTtlMs = parseFlexibleDuration(cfg.max_ttl) || 168 * 3600 * 1000;
  if (ttlMs > maxTtlMs) ttlMs = maxTtlMs;

  const maxUploads = typeof options.max === "string" ? parseInt(options.max, 10) : typeof options.max === "number" ? options.max : 0;
  const code = generateShortCode();
  const expiresDate = new Date(Date.now() + ttlMs);

  const channel: UploadChannel = {
    code,
    target_dir: absDir,
    rel_dir: relDir,
    created_at: new Date().toISOString(),
    expires_at: expiresDate.toISOString(),
    max_uploads: maxUploads,
    upload_count: 0,
    revoked: false,
    files: [],
  };

  store.addUploadChannel(channel);

  let uploadBaseURL = resolveUploadBaseUrl(cfg);
  if (options.domain) {
    const dom = options.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    uploadBaseURL = `https://${dom}/uploads`;
  }
  const uploadURL = `${uploadBaseURL}/${code}/`;

  console.log("Upload Channel Created Successfully:");
  console.log(`  Code:        ${code}`);
  console.log(`  URL:         ${uploadURL}`);
  console.log(`  Target Dir:  ${absDir} (${relDir})`);
  console.log(`  Expires:     ${expiresDate.toLocaleString()} (in ${formatRemaining(ttlMs)})`);
  if (maxUploads > 0) {
    console.log(`  Max Files:   ${maxUploads}`);
  } else {
    console.log(`  Max Files:   Unlimited`);
  }
}

export async function cliList(options: { config?: string } = {}): Promise<void> {
  const cfg = loadConfig(options.config);
  const store = new Store(cfg.data_file, cfg.upload_data_file);
  const { shares, uploads } = store.list();

  console.log("=== DOWNLOAD SHARES ===");
  console.log("CODE       FILENAME                 STATUS   DOWNLOADS   EXPIRES AT");

  if (shares.length === 0) {
    console.log("-          (no active or historical shares)");
  } else {
    for (const s of shares) {
      let status = "Active";
      if (s.revoked) status = "Revoked";
      else if (new Date() > new Date(s.expires_at)) status = "Expired";
      else if (s.max_downloads > 0 && s.download_count >= s.max_downloads) status = "Exhausted";

      const countStr = s.max_downloads > 0 ? `${s.download_count}/${s.max_downloads}` : `${s.download_count}`;
      const expStr = s.expires_at.slice(0, 16).replace("T", " ");
      const codePad = s.code.padEnd(10, " ");
      const filePad = s.filename.length > 24 ? s.filename.slice(0, 21) + "..." : s.filename.padEnd(24, " ");
      const statusPad = status.padEnd(8, " ");
      const countPad = countStr.padEnd(11, " ");

      console.log(`${codePad} ${filePad} ${statusPad} ${countPad} ${expStr}`);
    }
  }

  console.log("\n=== UPLOAD CHANNELS ===");
  console.log("CODE       TARGET DIR   STATUS   UPLOADS     EXPIRES AT");

  if (uploads.length === 0) {
    console.log("-          (no upload channels)");
  } else {
    for (const u of uploads) {
      let status = "Active";
      if (u.revoked) status = "Revoked";
      else if (new Date() > new Date(u.expires_at)) status = "Expired";
      else if (u.max_uploads > 0 && u.upload_count >= u.max_uploads) status = "Exhausted";

      const countStr = u.max_uploads > 0 ? `${u.upload_count}/${u.max_uploads}` : `${u.upload_count}`;
      const expStr = u.expires_at.slice(0, 16).replace("T", " ");
      const codePad = u.code.padEnd(10, " ");
      const dirPad = u.rel_dir.length > 12 ? u.rel_dir.slice(0, 9) + "..." : u.rel_dir.padEnd(12, " ");
      const statusPad = status.padEnd(8, " ");
      const countPad = countStr.padEnd(11, " ");

      console.log(`${codePad} ${dirPad} ${statusPad} ${countPad} ${expStr}`);
    }
  }
}

export async function cliRevoke(code: string, options: { config?: string } = {}): Promise<void> {
  if (!code) {
    console.error("Error: code is required");
    process.exit(1);
  }

  const cfg = loadConfig(options.config);
  const store = new Store(cfg.data_file, cfg.upload_data_file);

  const { revoked, kind } = store.revoke(code);
  if (!revoked) {
    console.error(`Code "${code}" not found in shares or upload channels.`);
    process.exit(1);
  }

  console.log(`Successfully revoked ${kind} with code "${code}".`);
}

export async function cliPrune(options: { config?: string } = {}): Promise<void> {
  const cfg = loadConfig(options.config);
  const store = new Store(cfg.data_file, cfg.upload_data_file);

  const { prunedShares, prunedUploads } = store.prune(0);
  console.log(`Prune completed: removed ${prunedShares} expired/revoked shares, ${prunedUploads} upload channels.`);
}
