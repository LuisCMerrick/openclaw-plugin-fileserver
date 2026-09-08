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

  // 优先使用客户端/用户实际访问网关时捕获的真实 Host
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

  const vhostDirs = [
    "/usr/local/nginx/conf/vhost",
    "/etc/nginx/sites-enabled",
    "/etc/nginx/conf.d",
    "/etc/nginx/vhost",
  ];

  const serverNameRegex = /^\s*server_name\s+([^;]+);/im;
  let fallbackDomain = "";

  for (const dir of vhostDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".conf") && !dir.includes("sites-enabled")) continue;
        const fullPath = path.join(dir, file);
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          let currentNames: string[] = [];
          for (const line of lines) {
            const match = serverNameRegex.exec(line);
            if (match && match[1]) {
              const names = match[1].trim().split(/\s+/);
              for (let name of names) {
                name = name.trim();
                if (name && name !== "_" && name !== "localhost" && !name.startsWith("*")) {
                  currentNames.push(name);
                }
              }
            }
          }

          if (currentNames.length > 0) {
            // 优先匹配反向代理到 OpenClaw Gateway (18789 / openclaw_backend) 的虚拟主机
            const isOpenClawVhost =
              content.includes("openclaw_backend") ||
              content.includes("18789") ||
              file.toLowerCase().includes("openclaw");

            if (isOpenClawVhost) {
              return currentNames[0];
            }

            if (!fallbackDomain) {
              fallbackDomain = currentNames[0];
            }
          }
        } catch {
          // ignore unreadable files
        }
      }
    } catch {
      // ignore
    }
  }

  if (fallbackDomain) {
    return fallbackDomain;
  }

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
    scheme = proto;
  } else {
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "") as string;
    if (host === "127.0.0.1:18790" || host.startsWith("localhost")) {
      scheme = "http";
    }
  }

  let host = (req.headers["x-forwarded-host"] || req.headers.host) as string | undefined;
  if (host) {
    recordSeenHost(host);
  } else {
    host = detectActiveDomain();
  }

  return `${scheme}://${host}`;
}
