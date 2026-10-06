import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";

let memoryRecordedHost = "";

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
  if (
    !cleaned ||
    cleaned.startsWith("127.") ||
    cleaned.startsWith("localhost") ||
    cleaned.startsWith("0.0.0.0") ||
    cleaned.startsWith("10.") ||
    cleaned.startsWith("192.168.") ||
    cleaned.startsWith("172.16.") ||
    cleaned.startsWith("172.17.") ||
    cleaned.startsWith("172.18.")
  ) {
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

export function detectActiveDomain(): string {
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

  const vhostDirs: string[] = [];

  const hostname = os.hostname();
  if (hostname) {
    return hostname;
  }

  return "localhost";
}

export function requestOrigin(req: IncomingMessage): string {
  let scheme = "https";
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.length > 0) {
    scheme = proto.split(",")[0]?.trim() || "https";
  } else if ((req.socket as any)?.encrypted || req.headers["x-forwarded-ssl"] === "on") {
    scheme = "https";
  } else {
    const rawHost = (req.headers["x-forwarded-host"] || req.headers.host || "") as string;
    const hostOnly = rawHost.split(",")[0]?.trim().split(":")[0] || "";
    if (
      hostOnly === "localhost" ||
      hostOnly.startsWith("127.") ||
      hostOnly === "0.0.0.0" ||
      hostOnly === "::1" ||
      hostOnly.startsWith("192.168.") ||
      hostOnly.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[01])$/.test(hostOnly)
    ) {
      scheme = "http";
    }
  }

  const rawHostHeader = (req.headers["x-forwarded-host"] || req.headers.host) as string | undefined;
  let host = rawHostHeader ? rawHostHeader.split(",")[0]?.trim() : undefined;
  if (host) {
    recordSeenHost(host);
  } else {
    host = detectActiveDomain();
  }

  return `${scheme}://${host}`;
}
