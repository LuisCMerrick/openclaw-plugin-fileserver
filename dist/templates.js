import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_UPLOAD_HTML, DEFAULT_ERROR_HTML } from "./defaultTemplates.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function formatBytes(bytes) {
    if (bytes === 0)
        return "0 B";
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
function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
let errorHtmlTemplate = null;
let uploadHtmlTemplate = null;
function loadTemplates() {
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
            }
            catch { }
        }
        if (!uploadHtmlTemplate && fs.existsSync(up)) {
            try {
                uploadHtmlTemplate = fs.readFileSync(up, "utf-8");
            }
            catch { }
        }
    }
}
export function renderErrorPage(status, title, message) {
    loadTemplates();
    const template = errorHtmlTemplate || DEFAULT_ERROR_HTML;
    return template
        .replace(/{{\.Status}}/g, String(status))
        .replace(/{{\.Title}}/g, escapeHtml(title))
        .replace(/{{\.Message}}/g, escapeHtml(message));
}
export function renderUploadPage(channel, maxBytes) {
    loadTemplates();
    const expTime = new Date(channel.expires_at).getTime();
    const remainingSeconds = Math.max(0, Math.floor((expTime - Date.now()) / 1000));
    let limitDesc = "Unlimited";
    if (channel.max_uploads > 0) {
        limitDesc = `${channel.max_uploads} files (${channel.upload_count} received)`;
    }
    let maxSizeDesc = `${(maxBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (maxBytes < 1024 * 1024 * 1024) {
        maxSizeDesc = `${(maxBytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    const template = uploadHtmlTemplate || DEFAULT_UPLOAD_HTML;
    let rendered = template
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
                      <a href="/d/${escapeHtml(channel.code)}/${encodeURIComponent(f.filename)}" target="_blank" class="btn-sm">Download</a>
                  </div>
              </div>`;
            }
            const replacedFilesBlock = `
          <div class="history-list" id="history-list">
              ${historyItems}
          </div>`;
            rendered = rendered.replace(filesSectionRegex, replacedFilesBlock);
        }
        else {
            const emptyBlock = `<div class="empty-state" id="empty-state">No uploaded files yet</div>`;
            rendered = rendered.replace(filesSectionRegex, emptyBlock);
        }
    }
    return rendered;
}
