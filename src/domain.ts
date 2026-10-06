import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import type { IncomingMessage } from "node:http";
import { resolveOpenClawGatewayConfig } from "./config.js";

let memoryRecordedHost = "";

/**
 * Checks if a host/IP is private, loopback, link-local, or local broadcast/unspecified.
 * Uses standard IP structure and CIDR boundaries without hardcoded subnet strings.
 */
export function isPrivateOrLoopbackHost(rawHost?: string): boolean {
  if (!rawHost) return true;
  let host = rawHost.trim().split(",")[0]?.trim() || "";
  if (!host) return true;

  // Handle IPv6 bracket format [::1]:port
  if (host.startsWith("[") && host.includes("]")) {
    host = host.slice(1, host.indexOf("]"));
  } else {
    // Strip port if single colon (IPv4:port or hostname:port)
    const colons = (host.match(/:/g) || []).length;
    if (colons === 1) {
      host = host.split(":")[0]!;
    }
  }
  host = host.toLowerCase();

  // Check common local and non-routable hostnames
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const parts = host.split(".").map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
      const [b0, b1] = parts;
      if (b0 === 0 || b0 === 127) return true; // 0.0.0.0/8 (current net) & 127.0.0.0/8 (loopback)
      if (b0 === 10) return true; // 10.0.0.0/8 (RFC 1918)
      if (b0 === 172 && b1! >= 16 && b1! <= 31) return true; // 172.16.0.0/12 (RFC 1918)
      if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16 (RFC 1918)
      if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 (link-local)
      if (b0 === 100 && b1! >= 64 && b1! <= 127) return true; // 100.64.0.0/10 (CGNAT / Tailscale)
    }
  } else if (ipVer === 6) {
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("fe80:") || /^fe[89ab][0-9a-f]:/i.test(host)) return true; // Link-local
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // Unique local (fc00::/7)
  }

  return false;
}

function getHostCacheFilePath(): string {
  const legacyDir = "/var/lib/openclaw-fileserver";
  if (fs.existsSync(legacyDir)) {
    return path.join(legacyDir, "last-seen-host.txt");
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "data", "fileserver", "last-seen-host.txt");
}

export function recordSeenHost(hostHeader?: string): void {
  if (!hostHeader) return;
  const cleaned = hostHeader.trim().split(",")[0]?.trim();
  if (!cleaned || isPrivateOrLoopbackHost(cleaned)) {
    return;
  }
  memoryRecordedHost = cleaned;
  try {
    const cacheFile = getHostCacheFilePath();
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, cleaned, "utf-8");
  } catch {
    // ignore
  }
}

export function getRecordedHost(): string | null {
  if (memoryRecordedHost) return memoryRecordedHost;
  try {
    const cacheFile = getHostCacheFilePath();
    if (fs.existsSync(cacheFile)) {
      const saved = fs.readFileSync(cacheFile, "utf-8").trim();
      if (saved) {
        memoryRecordedHost = saved;
        return saved;
      }
    }
  } catch {}
  return null;
}

export function detectActiveDomain(gatewayConfig?: any): string {
  const envDomain = process.env.OPENCLAW_DOMAIN?.trim();
  if (envDomain) {
    return envDomain;
  }

  // Prioritize active host observed from real client/user traffic hitting the Gateway
  const seenHost = getRecordedHost();
  if (seenHost) {
    return seenHost;
  }

  const envUrls = [process.env.OPENCLAW_BASE_URL, process.env.PUBLIC_URL, process.env.GATEWAY_URL];
  for (const raw of envUrls) {
    if (raw && raw.trim()) {
      const val = raw.trim();
      if (val.startsWith("http://") || val.startsWith("https://")) {
        try {
          const u = new URL(val);
          if (u.host) return u.host;
        } catch {}
      }
      return val;
    }
  }

  // Check OpenClaw Gateway configuration (publicOrigin or Control UI allowed origins)
  const gw = resolveOpenClawGatewayConfig(gatewayConfig);
  if (gw) {
    if (gw.publicOrigin && typeof gw.publicOrigin === "string") {
      try {
        const u = new URL(gw.publicOrigin);
        if (u.host && !isPrivateOrLoopbackHost(u.host)) return u.host;
      } catch {}
    }
    const origins = gw.controlUi?.allowedOrigins;
    if (Array.isArray(origins)) {
      for (const origin of origins) {
        if (typeof origin === "string" && (origin.startsWith("http://") || origin.startsWith("https://"))) {
          try {
            const u = new URL(origin);
            if (u.host && !isPrivateOrLoopbackHost(u.host)) return u.host;
          } catch {}
        }
      }
    }
  }

  const hostname = os.hostname();
  if (hostname && !hostname.startsWith("localhost")) {
    return hostname;
  }

  return "localhost";
}

export function requestOrigin(req: IncomingMessage, gatewayConfig?: any): string {
  let scheme = "https";
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.length > 0) {
    scheme = proto.split(",")[0]?.trim() || "https";
  } else if ((req.socket as any)?.encrypted || req.headers["x-forwarded-ssl"] === "on") {
    scheme = "https";
  } else {
    const rawHost = (req.headers["x-forwarded-host"] || req.headers.host || "") as string;
    if (isPrivateOrLoopbackHost(rawHost)) {
      scheme = "http";
    }
  }

  const rawHostHeader = (req.headers["x-forwarded-host"] || req.headers.host) as string | undefined;
  let host = rawHostHeader ? rawHostHeader.split(",")[0]?.trim() : undefined;
  if (host) {
    recordSeenHost(host);
  } else {
    host = detectActiveDomain(gatewayConfig);
  }

  return `${scheme}://${host}`;
}

