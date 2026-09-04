import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";
import type { FileserverConfig } from "./types.js";
import { detectActiveDomain, requestOrigin } from "./domain.js";

export const DEFAULT_CONFIG_PATH = "/etc/openclaw-fileserver/config.json";

function resolveDefaultWorkspace(): string {
  return process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), ".openclaw", "workspace");
}

export function getDefaultConfig(): FileserverConfig {
  const defaultWs = resolveDefaultWorkspace();
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
    data_file: "/var/lib/openclaw-fileserver/shares.json",
    upload_data_file: "/var/lib/openclaw-fileserver/uploads.json",
    max_upload_bytes: 1024 * 1024 * 1024, // 1GB
  };
}

export function parseFlexibleDuration(s: string): number {
  if (!s) return 0;
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

export function getDateMinuteSubdir(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}/${m}/${d}/${hh}${mm}`;
}

export function resolveUploadTargetDir(specificDir?: string, date = new Date()): string {
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

export function loadConfig(configPath?: string): FileserverConfig {
  const cfg = getDefaultConfig();
  let targetPath = configPath;

  if (!targetPath) {
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      targetPath = DEFAULT_CONFIG_PATH;
    } else if (fs.existsSync("config.json")) {
      targetPath = "config.json";
    }
  }

  if (targetPath && fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, "utf-8");
      const parsed = JSON.parse(raw);
      Object.assign(cfg, parsed);
    } catch (err) {
      console.warn(`[openclaw-fileserver] Failed to parse config ${targetPath}:`, err);
    }
  }

  if (!cfg.allowed_root) {
    cfg.allowed_root = resolveDefaultWorkspace();
  }
  try {
    cfg.allowed_root = path.resolve(cfg.allowed_root);
  } catch {
    // ignore
  }

  if (!cfg.max_upload_bytes || cfg.max_upload_bytes <= 0) {
    cfg.max_upload_bytes = 1024 * 1024 * 1024;
  }

  return cfg;
}

export function resolveBaseUrl(cfg: FileserverConfig, req?: IncomingMessage): string {
  if (req) {
    return `${requestOrigin(req)}/d`;
  }
  if (cfg.base_url === "auto" || !cfg.base_url || cfg.base_url.startsWith("/")) {
    return `https://${detectActiveDomain()}/d`;
  }
  return cfg.base_url.replace(/\/+$/, "");
}

export function resolveUploadBaseUrl(cfg: FileserverConfig, req?: IncomingMessage): string {
  if (req) {
    return `${requestOrigin(req)}/uploads`;
  }
  if (cfg.upload_base_url === "auto" || !cfg.upload_base_url || cfg.upload_base_url.startsWith("/")) {
    return `https://${detectActiveDomain()}/uploads`;
  }
  return cfg.upload_base_url.replace(/\/+$/, "");
}
