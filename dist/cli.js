#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig, resolveBaseUrl, resolveUploadBaseUrl, parseFlexibleDuration } from "./config.js";
import { Store } from "./store.js";
import { FileserverServer } from "./server.js";
import { safeResolve, generateShortCode } from "./security.js";
import { formatBytes } from "./templates.js";
function printUsage() {
    console.log(`OpenClaw Secure File Transport Service (openclaw-fileserver)

Usage:
  openclaw-fileserver serve [-config <path>]
      Start the HTTP file server daemon

  openclaw-fileserver share [-config <path>] [-domain <domain>] [-ttl 24h] [-max 0] [-inline] <filepath>
      Generate clean URL download link for a workspace file

  openclaw-fileserver receive [-config <path>] [-domain <domain>] [-ttl 24h] [-dir uploads] [-max 0]
      Create an upload drop portal for receiving files

  openclaw-fileserver list [-config <path>]
      List all active and expired shares and upload channels

  openclaw-fileserver revoke [-config <path>] <code>
      Revoke a download share or upload channel by short code

  openclaw-fileserver prune [-config <path>]
      Prune expired and revoked records from storage`);
}
function parseArgs(args) {
    if (args.length === 0) {
        return { cmd: "help", flags: {}, positional: [] };
    }
    const cmd = args[0];
    const flags = {};
    const positional = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("-")) {
            const flagName = arg.replace(/^-+/, "");
            if (flagName === "inline") {
                flags["inline"] = true;
            }
            else if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                flags[flagName] = args[i + 1];
                i++;
            }
            else {
                flags[flagName] = true;
            }
        }
        else {
            positional.push(arg);
        }
    }
    return { cmd, flags, positional };
}
function formatRemaining(ms) {
    if (ms <= 0)
        return "0s";
    let s = Math.round(ms / 1000);
    const days = Math.floor(s / 86400);
    s %= 86400;
    const hours = Math.floor(s / 3600);
    s %= 3600;
    const mins = Math.floor(s / 60);
    s %= 60;
    const parts = [];
    if (days > 0)
        parts.push(`${days}d`);
    if (hours > 0)
        parts.push(`${hours}h`);
    if (mins > 0)
        parts.push(`${mins}m`);
    if (s > 0 || parts.length === 0)
        parts.push(`${s}s`);
    return parts.join(" ");
}
async function main() {
    const args = process.argv.slice(2);
    const { cmd, flags, positional } = parseArgs(args);
    const configPath = typeof flags["config"] === "string" ? flags["config"] : undefined;
    switch (cmd) {
        case "serve": {
            const cfg = loadConfig(configPath);
            const store = new Store(cfg.data_file, cfg.upload_data_file);
            const server = new FileserverServer(cfg, store);
            await server.start();
            break;
        }
        case "share": {
            const filePath = positional[0];
            if (!filePath) {
                console.error("Error: file path is required");
                console.error("Usage: openclaw-fileserver share [-ttl 24h] [-max 0] [-inline] <filepath>");
                process.exit(1);
            }
            const cfg = loadConfig(configPath);
            const store = new Store(cfg.data_file, cfg.upload_data_file);
            let absPath = "";
            let relPath = "";
            try {
                const resolved = safeResolve(cfg.allowed_root, filePath);
                absPath = resolved.absPath;
                relPath = resolved.relPath;
            }
            catch (err) {
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
            if (typeof flags["ttl"] === "string") {
                const parsed = parseFlexibleDuration(flags["ttl"]);
                if (parsed > 0)
                    ttlMs = parsed;
            }
            const maxTtlMs = parseFlexibleDuration(cfg.max_ttl) || 168 * 3600 * 1000;
            if (ttlMs > maxTtlMs)
                ttlMs = maxTtlMs;
            const maxDownloads = typeof flags["max"] === "string" ? parseInt(flags["max"], 10) : 0;
            const inline = !!flags["inline"];
            const code = generateShortCode();
            const filename = path.basename(absPath);
            const expiresDate = new Date(Date.now() + ttlMs);
            const record = {
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
            if (typeof flags["domain"] === "string") {
                const dom = flags["domain"].replace(/^https?:\/\//, "").replace(/\/+$/, "");
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
            }
            else {
                console.log(`  Max Downloads: Unlimited`);
            }
            if (inline) {
                console.log(`  Mode:        Inline Preview`);
            }
            break;
        }
        case "receive": {
            const cfg = loadConfig(configPath);
            const store = new Store(cfg.data_file, cfg.upload_data_file);
            const targetDirFlag = typeof flags["dir"] === "string" ? flags["dir"] : "uploads";
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
            }
            catch (err) {
                console.error("Security check failed on target directory:", err.message);
                process.exit(1);
            }
            if (!fs.existsSync(absDir)) {
                fs.mkdirSync(absDir, { recursive: true, mode: 0o750 });
            }
            let ttlMs = parseFlexibleDuration(cfg.default_ttl) || 24 * 3600 * 1000;
            if (typeof flags["ttl"] === "string") {
                const parsed = parseFlexibleDuration(flags["ttl"]);
                if (parsed > 0)
                    ttlMs = parsed;
            }
            const maxTtlMs = parseFlexibleDuration(cfg.max_ttl) || 168 * 3600 * 1000;
            if (ttlMs > maxTtlMs)
                ttlMs = maxTtlMs;
            const maxUploads = typeof flags["max"] === "string" ? parseInt(flags["max"], 10) : 0;
            const code = generateShortCode();
            const expiresDate = new Date(Date.now() + ttlMs);
            const channel = {
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
            if (typeof flags["domain"] === "string") {
                const dom = flags["domain"].replace(/^https?:\/\//, "").replace(/\/+$/, "");
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
            }
            else {
                console.log(`  Max Files:   Unlimited`);
            }
            break;
        }
        case "list": {
            const cfg = loadConfig(configPath);
            const store = new Store(cfg.data_file, cfg.upload_data_file);
            const { shares, uploads } = store.list();
            console.log("=== DOWNLOAD SHARES ===");
            console.log("CODE       FILENAME                 STATUS   DOWNLOADS   EXPIRES AT");
            if (shares.length === 0) {
                console.log("-          (no active or historical shares)");
            }
            else {
                for (const s of shares) {
                    let status = "Active";
                    if (s.revoked)
                        status = "Revoked";
                    else if (new Date() > new Date(s.expires_at))
                        status = "Expired";
                    else if (s.max_downloads > 0 && s.download_count >= s.max_downloads)
                        status = "Exhausted";
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
            }
            else {
                for (const u of uploads) {
                    let status = "Active";
                    if (u.revoked)
                        status = "Revoked";
                    else if (new Date() > new Date(u.expires_at))
                        status = "Expired";
                    else if (u.max_uploads > 0 && u.upload_count >= u.max_uploads)
                        status = "Exhausted";
                    const countStr = u.max_uploads > 0 ? `${u.upload_count}/${u.max_uploads}` : `${u.upload_count}`;
                    const expStr = u.expires_at.slice(0, 16).replace("T", " ");
                    const codePad = u.code.padEnd(10, " ");
                    const dirPad = u.rel_dir.length > 12 ? u.rel_dir.slice(0, 9) + "..." : u.rel_dir.padEnd(12, " ");
                    const statusPad = status.padEnd(8, " ");
                    const countPad = countStr.padEnd(11, " ");
                    console.log(`${codePad} ${dirPad} ${statusPad} ${countPad} ${expStr}`);
                }
            }
            break;
        }
        case "revoke": {
            const code = positional[0];
            if (!code) {
                console.error("Error: code is required");
                console.error("Usage: openclaw-fileserver revoke <code>");
                process.exit(1);
            }
            const cfg = loadConfig(configPath);
            const store = new Store(cfg.data_file, cfg.upload_data_file);
            const { revoked, kind } = store.revoke(code);
            if (!revoked) {
                console.error(`Code "${code}" not found in shares or upload channels.`);
                process.exit(1);
            }
            console.log(`Successfully revoked ${kind} with code "${code}".`);
            break;
        }
        case "prune": {
            const cfg = loadConfig(configPath);
            const store = new Store(cfg.data_file, cfg.upload_data_file);
            const { prunedShares, prunedUploads } = store.prune(0);
            console.log(`Prune completed: removed ${prunedShares} expired/revoked shares, ${prunedUploads} upload channels.`);
            break;
        }
        case "help":
        case "-h":
        case "--help":
        default:
            printUsage();
            break;
    }
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
