import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export function detectActiveDomain() {
    const envDomain = process.env.OPENCLAW_DOMAIN?.trim();
    if (envDomain) {
        return envDomain;
    }
    const envUrls = [process.env.OPENCLAW_BASE_URL, process.env.PUBLIC_URL, process.env.GATEWAY_URL];
    for (const raw of envUrls) {
        if (raw && raw.trim()) {
            const val = raw.trim();
            if (val.startsWith("http://") || val.startsWith("https://")) {
                try {
                    const u = new URL(val);
                    if (u.host)
                        return u.host;
                }
                catch { }
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
    for (const dir of vhostDirs) {
        if (!fs.existsSync(dir))
            continue;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (!file.endsWith(".conf") && !dir.includes("sites-enabled"))
                    continue;
                const fullPath = path.join(dir, file);
                try {
                    const content = fs.readFileSync(fullPath, "utf-8");
                    const lines = content.split("\n");
                    for (const line of lines) {
                        const match = serverNameRegex.exec(line);
                        if (match && match[1]) {
                            const names = match[1].trim().split(/\s+/);
                            for (let name of names) {
                                name = name.trim();
                                if (name && name !== "_" && name !== "localhost" && !name.startsWith("*")) {
                                    return name;
                                }
                            }
                        }
                    }
                }
                catch {
                    // ignore unreadable files
                }
            }
        }
        catch {
            // ignore
        }
    }
    const hostname = os.hostname();
    if (hostname) {
        return hostname;
    }
    return "localhost";
}
export function requestOrigin(req) {
    let scheme = "https";
    const proto = req.headers["x-forwarded-proto"];
    if (typeof proto === "string" && proto.length > 0) {
        scheme = proto;
    }
    else {
        const host = (req.headers["x-forwarded-host"] || req.headers.host || "");
        if (host === "127.0.0.1:18790" || host.startsWith("localhost")) {
            scheme = "http";
        }
    }
    let host = (req.headers["x-forwarded-host"] || req.headers.host);
    if (!host) {
        host = detectActiveDomain();
    }
    return `${scheme}://${host}`;
}
