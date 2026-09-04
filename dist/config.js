import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectActiveDomain, requestOrigin } from "./domain.js";
export function resolveDefaultWorkspace() {
    if (process.env.OPENCLAW_WORKSPACE && process.env.OPENCLAW_WORKSPACE.trim()) {
        return path.resolve(process.env.OPENCLAW_WORKSPACE.trim());
    }
    return path.join(os.homedir(), ".openclaw", "workspace");
}
export function resolveDefaultStateDir() {
    if (process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_STATE_DIR.trim()) {
        return path.resolve(process.env.OPENCLAW_STATE_DIR.trim());
    }
    return path.join(os.homedir(), ".openclaw");
}
export function resolveDefaultDataFiles() {
    const legacyDir = "/var/lib/openclaw-fileserver";
    try {
        if (fs.existsSync(legacyDir)) {
            fs.accessSync(legacyDir, fs.constants.W_OK);
            return {
                dataFile: path.join(legacyDir, "shares.json"),
                uploadDataFile: path.join(legacyDir, "uploads.json"),
            };
        }
    }
    catch {
        // legacy dir inaccessible or not writable
    }
    const standardDataDir = path.join(resolveDefaultStateDir(), "data", "fileserver");
    return {
        dataFile: path.join(standardDataDir, "shares.json"),
        uploadDataFile: path.join(standardDataDir, "uploads.json"),
    };
}
export function resolveConfigPath(configPath) {
    if (configPath && fs.existsSync(configPath)) {
        return path.resolve(configPath);
    }
    const candidates = [
        path.resolve("fileserver.json"),
        path.resolve("config.json"),
        path.join(resolveDefaultStateDir(), "fileserver.json"),
        path.join(resolveDefaultStateDir(), "config", "fileserver.json"),
        "/etc/openclaw-fileserver/config.json",
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        catch {
            // ignore
        }
    }
    return null;
}
export function getDefaultConfig() {
    const defaultWs = resolveDefaultWorkspace();
    const { dataFile, uploadDataFile } = resolveDefaultDataFiles();
    return {
        bind_addr: "none",
        base_url: "auto",
        upload_base_url: "auto",
        upload_dir: path.join(defaultWs, "uploads"),
        secret_key: "",
        allowed_root: defaultWs,
        default_ttl: "24h",
        max_ttl: "168h",
        api_token: "",
        data_file: dataFile,
        upload_data_file: uploadDataFile,
        max_upload_bytes: 1024 * 1024 * 1024, // 1GB
    };
}
export function parseFlexibleDuration(s) {
    if (!s)
        return 0;
    const str = s.trim().toLowerCase();
    if (str.endsWith("d")) {
        const days = parseInt(str.slice(0, -1), 10);
        if (!isNaN(days) && days > 0) {
            return days * 24 * 3600 * 1000;
        }
    }
    if (str.endsWith("h")) {
        const hours = parseFloat(str.slice(0, -1));
        if (!isNaN(hours) && hours > 0) {
            return Math.round(hours * 3600 * 1000);
        }
    }
    if (str.endsWith("m")) {
        const mins = parseFloat(str.slice(0, -1));
        if (!isNaN(mins) && mins > 0) {
            return Math.round(mins * 60 * 1000);
        }
    }
    if (str.endsWith("s")) {
        const secs = parseFloat(str.slice(0, -1));
        if (!isNaN(secs) && secs > 0) {
            return Math.round(secs * 1000);
        }
    }
    return 0;
}
export function getDateMinuteSubdir(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    return `${y}/${m}/${d}/${hh}${mm}`;
}
export function resolveUploadTargetDir(specificDir, date = new Date()) {
    const timeSubdir = getDateMinuteSubdir(date);
    const base = specificDir?.trim();
    if (!base || base === "uploads") {
        return path.join("uploads", timeSubdir);
    }
    if (/\d{4}[\/\-_]\d{2}[\/\-_]\d{2}/.test(base)) {
        return base;
    }
    return path.join(base, timeSubdir);
}
export function loadConfig(configPath, overrides) {
    const cfg = getDefaultConfig();
    const targetPath = resolveConfigPath(configPath);
    if (targetPath && fs.existsSync(targetPath)) {
        try {
            const raw = fs.readFileSync(targetPath, "utf-8");
            const parsed = JSON.parse(raw);
            Object.assign(cfg, parsed);
        }
        catch (err) {
            console.warn(`[openclaw-fileserver] Failed to parse config ${targetPath}:`, err);
        }
    }
    if (overrides) {
        Object.assign(cfg, overrides);
    }
    if (!cfg.allowed_root) {
        cfg.allowed_root = resolveDefaultWorkspace();
    }
    try {
        cfg.allowed_root = path.resolve(cfg.allowed_root);
    }
    catch {
        // ignore
    }
    if (!cfg.max_upload_bytes || cfg.max_upload_bytes <= 0) {
        cfg.max_upload_bytes = 1024 * 1024 * 1024;
    }
    return cfg;
}
export function resolveBaseUrl(cfg, req) {
    if (req) {
        return `${requestOrigin(req)}/d`;
    }
    if (cfg.base_url === "auto" || !cfg.base_url || cfg.base_url.startsWith("/")) {
        return `https://${detectActiveDomain()}/d`;
    }
    return cfg.base_url.replace(/\/+$/, "");
}
export function resolveUploadBaseUrl(cfg, req) {
    if (req) {
        return `${requestOrigin(req)}/uploads`;
    }
    if (cfg.upload_base_url === "auto" || !cfg.upload_base_url || cfg.upload_base_url.startsWith("/")) {
        return `https://${detectActiveDomain()}/uploads`;
    }
    return cfg.upload_base_url.replace(/\/+$/, "");
}
