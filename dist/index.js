import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig, resolveBaseUrl, resolveUploadBaseUrl, parseFlexibleDuration, resolveUploadTargetDir } from "./config.js";
import { Store } from "./store.js";
import { FileserverServer } from "./server.js";
import { safeResolve, generateShortCode } from "./security.js";
import { formatBytes } from "./templates.js";
function jsonResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2),
            },
        ],
        details: payload,
    };
}
export default function register(api) {
    const pluginConfigOverrides = api.config?.plugins?.entries?.["fileserver"]?.config || {};
    const cfg = loadConfig(undefined, pluginConfigOverrides, api.config);
    const store = new Store(cfg.data_file, cfg.upload_data_file);
    const serverInstance = new FileserverServer(cfg, store);
    // 1. Register Gateway native HTTP routes (mounted directly onto Gateway HTTP server; Nginx only needs a single location /)
    const routeHandler = (req, res) => {
        serverInstance.handleRequest(req, res);
    };
    try {
        api.registerHttpRoute?.({
            path: "/d",
            match: "prefix",
            auth: "plugin",
            replaceExisting: true,
            handler: routeHandler,
        });
        api.registerHttpRoute?.({
            path: "/uploads",
            match: "prefix",
            auth: "plugin",
            replaceExisting: true,
            handler: routeHandler,
        });
        api.registerHttpRoute?.({
            path: "/api/share",
            match: "exact",
            auth: "plugin",
            replaceExisting: true,
            handler: routeHandler,
        });
        api.logger?.debug?.("[openclaw-fileserver] Registered native HTTP routes on Gateway: /d, /uploads, /api/share");
    }
    catch (err) {
        api.logger?.error?.(`[openclaw-fileserver] Failed to register HTTP routes: ${err.message}`);
    }
    // 2. Register Background Service (scheduled data pruning)
    api.registerService?.({
        id: "fileserver",
        async start(ctx) {
            try {
                if (cfg.bind_addr && cfg.bind_addr !== "none" && cfg.bind_addr !== "disabled") {
                    await serverInstance.start();
                }
                ctx?.serviceHealth?.clearFailure();
            }
            catch (err) {
                console.error("[openclaw-fileserver] Service startup error:", err);
                ctx?.serviceHealth?.reportFailure(err);
            }
        },
        async stop() {
            await serverInstance.stop();
        },
    });
    // 3. Register OpenClaw native CLI subcommands: `openclaw fileserver <subcommand>`
    try {
        api.registerCli?.(async ({ program }) => {
            const fsCmd = program.command("fileserver").description("OpenClaw Secure File Transport Service");
            fsCmd
                .command("share <filepath>")
                .description("Generate clean URL download link for a workspace file")
                .option("-t, --ttl <duration>", "Time to live (e.g. 24h, 3d)", "24h")
                .option("-m, --max <number>", "Maximum downloads allowed (0 = unlimited)", "0")
                .option("-i, --inline", "Serve with inline preview mode", false)
                .option("--domain <domain>", "Custom domain override")
                .option("-c, --config <path>", "Path to configuration file")
                .action(async (filepath, options) => {
                const { cliShare } = await import("./cli-commands.js");
                await cliShare(filepath, options);
            });
            fsCmd
                .command("receive")
                .description("Create an upload drop portal for receiving files")
                .option("-d, --dir <directory>", "Relative directory under workspace", "uploads")
                .option("-t, --ttl <duration>", "Time to live (e.g. 24h, 3d)", "24h")
                .option("-m, --max <number>", "Maximum total files allowed (0 = unlimited)", "0")
                .option("--domain <domain>", "Custom domain override")
                .option("-c, --config <path>", "Path to configuration file")
                .action(async (options) => {
                const { cliReceive } = await import("./cli-commands.js");
                await cliReceive(options);
            });
            fsCmd
                .command("list")
                .description("List all active and expired shares and upload channels")
                .option("-c, --config <path>", "Path to configuration file")
                .action(async (options) => {
                const { cliList } = await import("./cli-commands.js");
                await cliList(options);
            });
            fsCmd
                .command("revoke <code>")
                .description("Revoke a download share or upload channel by short code")
                .option("-c, --config <path>", "Path to configuration file")
                .action(async (code, options) => {
                const { cliRevoke } = await import("./cli-commands.js");
                await cliRevoke(code, options);
            });
            fsCmd
                .command("prune")
                .description("Prune expired and revoked records from storage")
                .option("-c, --config <path>", "Path to configuration file")
                .action(async (options) => {
                const { cliPrune } = await import("./cli-commands.js");
                await cliPrune(options);
            });
        }, {
            descriptors: [
                {
                    name: "fileserver",
                    description: "OpenClaw Secure File Transport Service",
                    hasSubcommands: true,
                },
            ],
        });
    }
    catch (err) {
        api.logger?.warn?.(`[openclaw-fileserver] Failed to register CLI commands: ${err.message}`);
    }
    // 4. Register Agent native Tools
    api.registerTool?.((ctx) => {
        return {
            name: "fileserver_share",
            description: "Generate a secure, clean URL download link for a file in the workspace.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative or absolute path of the file to share.",
                    },
                    ttl: {
                        type: "string",
                        description: "Optional expiration duration (e.g. '24h', '3d'). Defaults to '24h'.",
                    },
                    max_downloads: {
                        type: "number",
                        description: "Optional maximum allowed download count (0 = unlimited). Defaults to 0.",
                    },
                    inline: {
                        type: "boolean",
                        description: "Serve with inline preview mode instead of attachment disposition.",
                    },
                },
                required: ["path"],
            },
            async execute(_toolCallId, params) {
                let absPath;
                let relPath;
                try {
                    const resolved = safeResolve(cfg.allowed_root, params.path);
                    absPath = resolved.absPath;
                    relPath = resolved.relPath;
                }
                catch (err) {
                    return jsonResult({ error: `Security check failed: ${err.message}` });
                }
                if (!fs.existsSync(absPath)) {
                    return jsonResult({ error: `File not found: ${absPath}` });
                }
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) {
                    return jsonResult({ error: "Cannot share a directory; target must be a regular file." });
                }
                let ttlMs = parseFlexibleDuration(cfg.default_ttl) || 24 * 3600 * 1000;
                if (typeof params.ttl === "string") {
                    const parsed = parseFlexibleDuration(params.ttl);
                    if (parsed > 0)
                        ttlMs = parsed;
                }
                const maxTtlMs = parseFlexibleDuration(cfg.max_ttl) || 168 * 3600 * 1000;
                if (ttlMs > maxTtlMs)
                    ttlMs = maxTtlMs;
                const maxDownloads = typeof params.max_downloads === "number" ? params.max_downloads : 0;
                const inline = !!params.inline;
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
                const baseURL = resolveBaseUrl(cfg);
                const downloadURL = `${baseURL}/${code}/${encodeURIComponent(filename)}`;
                return jsonResult({
                    ok: true,
                    code,
                    url: downloadURL,
                    filename,
                    size_bytes: stat.size,
                    size_human: formatBytes(stat.size),
                    workspace_rel_path: relPath,
                    expires_at: expiresDate.toISOString(),
                    max_downloads: maxDownloads,
                    inline,
                });
            },
        };
    }, { optional: true });
    api.registerTool?.((ctx) => {
        return {
            name: "fileserver_receive",
            description: "Create a temporary Web upload channel for the user to drag-and-drop or upload files into the workspace.",
            parameters: {
                type: "object",
                properties: {
                    dir: {
                        type: "string",
                        description: "Relative directory in workspace to store uploaded files (default: 'uploads').",
                    },
                    ttl: {
                        type: "string",
                        description: "Optional expiration duration (e.g. '24h', '3d'). Defaults to '24h'.",
                    },
                    max_uploads: {
                        type: "number",
                        description: "Optional maximum allowed upload count (0 = unlimited). Defaults to 0.",
                    },
                },
            },
            async execute(_toolCallId, params) {
                const targetDir = resolveUploadTargetDir(params.dir);
                let destDir = targetDir;
                if (!path.isAbsolute(destDir)) {
                    destDir = path.join(cfg.allowed_root, destDir);
                }
                let absDir;
                let relDir;
                try {
                    const resolved = safeResolve(cfg.allowed_root, destDir);
                    absDir = resolved.absPath;
                    relDir = resolved.relPath;
                }
                catch (err) {
                    return jsonResult({ error: `Security check failed on target directory: ${err.message}` });
                }
                if (!fs.existsSync(absDir)) {
                    fs.mkdirSync(absDir, { recursive: true, mode: 0o750 });
                }
                let ttlMs = parseFlexibleDuration(cfg.default_ttl) || 24 * 3600 * 1000;
                if (typeof params.ttl === "string") {
                    const parsed = parseFlexibleDuration(params.ttl);
                    if (parsed > 0)
                        ttlMs = parsed;
                }
                const maxTtlMs = parseFlexibleDuration(cfg.max_ttl) || 168 * 3600 * 1000;
                if (ttlMs > maxTtlMs)
                    ttlMs = maxTtlMs;
                const maxUploads = typeof params.max_uploads === "number" ? params.max_uploads : 0;
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
                const uploadBaseURL = resolveUploadBaseUrl(cfg);
                const uploadURL = `${uploadBaseURL}/${code}/`;
                return jsonResult({
                    ok: true,
                    code,
                    url: uploadURL,
                    target_dir: absDir,
                    workspace_rel_dir: relDir,
                    expires_at: expiresDate.toISOString(),
                    max_uploads: maxUploads,
                });
            },
        };
    }, { optional: true });
    api.registerTool?.((ctx) => {
        return {
            name: "fileserver_list",
            description: "List active and historical file shares and upload channels.",
            parameters: {
                type: "object",
                properties: {},
            },
            async execute() {
                return jsonResult(store.list());
            },
        };
    }, { optional: true });
    api.registerTool?.((ctx) => {
        return {
            name: "fileserver_revoke",
            description: "Revoke an active download share or upload channel by its short code.",
            parameters: {
                type: "object",
                properties: {
                    code: {
                        type: "string",
                        description: "8-character short code to revoke.",
                    },
                },
                required: ["code"],
            },
            async execute(_toolCallId, params) {
                const res = store.revoke(params.code);
                if (!res.revoked) {
                    return jsonResult({ ok: false, error: `Code "${params.code}" not found.` });
                }
                return jsonResult({ ok: true, message: `Successfully revoked ${res.kind} with code "${params.code}".` });
            },
        };
    }, { optional: true });
}
