import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { UploadChannel } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < sizes.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${sizes[i]}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let errorHtmlTemplate: string | null = null;
let uploadHtmlTemplate: string | null = null;

function loadTemplates(): void {
  const possiblePaths = [
    path.resolve(__dirname, "../web"),
    path.resolve(__dirname, "web"),
    path.resolve(process.cwd(), "web"),
  ];

  for (const base of possiblePaths) {
    const ep = path.join(base, "error.html");
    const up = path.join(base, "upload.html");
    if (!errorHtmlTemplate && fs.existsSync(ep)) {
      try {
        errorHtmlTemplate = fs.readFileSync(ep, "utf-8");
      } catch {}
    }
    if (!uploadHtmlTemplate && fs.existsSync(up)) {
      try {
        uploadHtmlTemplate = fs.readFileSync(up, "utf-8");
      } catch {}
    }
  }
}

export function renderErrorPage(status: number, title: string, message: string): string {
  loadTemplates();
  if (errorHtmlTemplate) {
    return errorHtmlTemplate
      .replace(/{{\.Status}}/g, String(status))
      .replace(/{{\.Title}}/g, escapeHtml(title))
      .replace(/{{\.Message}}/g, escapeHtml(message));
  }

  // Built-in fallback
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><title>${status} - ${escapeHtml(title)}</title>
<style>
body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
.badge { display: inline-block; font-size: 14px; font-weight: 600; padding: 4px 12px; border-radius: 20px; margin-bottom: 20px; border: 1px solid #f85149; color: #f85149; background: rgba(248, 81, 73, 0.1); }
h1 { font-size: 24px; margin-bottom: 12px; color: #f0f6fc; }
p { font-size: 14px; color: #8b949e; line-height: 1.6; margin-bottom: 24px; }
.footer { font-size: 12px; color: #8b949e; border-top: 1px solid #30363d; padding-top: 16px; }
</style>
</head>
<body>
<div class="card">
<div class="badge">HTTP ${status}</div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<div class="footer">OpenClaw Secure File Transport</div>
</div>
</body>
</html>`;
}

export function renderUploadPage(channel: UploadChannel, maxBytes: number): string {
  loadTemplates();

  const expTime = new Date(channel.expires_at).getTime();
  const remainingSeconds = Math.max(0, Math.floor((expTime - Date.now()) / 1000));

  let limitDesc = "无限制";
  if (channel.max_uploads > 0) {
    limitDesc = `${channel.max_uploads} 个文件 (已接收 ${channel.upload_count})`;
  }

  let maxSizeDesc = `${(maxBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (maxBytes < 1024 * 1024 * 1024) {
    maxSizeDesc = `${(maxBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (uploadHtmlTemplate) {
    let rendered = uploadHtmlTemplate
      .replace(/{{\.Code}}/g, escapeHtml(channel.code))
      .replace(/{{\.RelDir}}/g, escapeHtml(channel.rel_dir))
      .replace(/{{\.LimitDesc}}/g, escapeHtml(limitDesc))
      .replace(/{{\.MaxSizeDesc}}/g, escapeHtml(maxSizeDesc))
      .replace(/{{\.RemainingSeconds}}/g, String(remainingSeconds));

    // Handle {{if .Files}} ... {{else}} ... {{end}}
    const filesSectionRegex = /{{if \.Files}}([\s\S]*?){{else}}([\s\S]*?){{end}}/;
    const match = filesSectionRegex.exec(rendered);
    if (match) {
      if (channel.files && channel.files.length > 0) {
        let historyItems = "";
        for (let i = channel.files.length - 1; i >= 0; i--) {
          const f = channel.files[i];
          const timeStr = new Date(f.uploaded_at).toTimeString().split(" ")[0] || "";
          historyItems += `
                <div class="history-item">
                    <span class="file-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="file-meta">${escapeHtml(formatBytes(f.size))} · ${escapeHtml(timeStr)}</span>
                        <a href="/d/${escapeHtml(channel.code)}/${encodeURIComponent(f.filename)}" target="_blank" class="btn-sm">下载</a>
                    </div>
                </div>`;
        }
        const replacedFilesBlock = `
            <div class="history-list" id="history-list">
                ${historyItems}
            </div>`;
        rendered = rendered.replace(filesSectionRegex, replacedFilesBlock);
      } else {
        const emptyBlock = `<div class="empty-state" id="empty-state">暂无已上传文件</div>`;
        rendered = rendered.replace(filesSectionRegex, emptyBlock);
      }
    }
    return rendered;
  }

  return `<h1>Upload Portal: ${escapeHtml(channel.code)}</h1>`;
}
