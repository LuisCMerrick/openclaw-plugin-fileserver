# OpenClaw Fileserver Plugin (`@LuisCMerrick/openclaw-plugin-fileserver`)

Production-grade secure file transport and distribution plugin for OpenClaw. Provides clean direct download URLs with HTTP Range resumption, temporary Web drop portals, memory-efficient streaming unpack, and time-partitioned auto-archiving—all routed over a single Gateway port.

---

## 🌟 Key Features

- **Single-Port Gateway Native Routing**:
  - Leverages OpenClaw's official SDK `api.registerHttpRoute` to directly mount `/d/*`, `/uploads/*`, and `/api/share` onto the Gateway's main HTTP server (port 18789).
  - Eliminates auxiliary sidecar ports (e.g. 18790).
  - **Zero Nginx configuration changes**: Nginx only needs its single root reverse proxy `location ^~ /`. No custom location blocks required for file transport.
- **8-Character Cryptographic Shortcodes**:
  - 30-character unambiguous alphabet excluding visually confusing glyphs (`0, O, 1, l, i`).
  - CSPRNG cryptographically secure pseudorandom generation with high collision resistance.
- **Physical Sandbox Isolation (`safeResolve`)**:
  - Confined strictly within `allowed_root` (defaults to the agent workspace).
  - Resolves real paths on disk via `fs.realpath` to prevent path traversal (`../`) and symlink directory escapes.
- **Full Range & RFC 5987 Protocol Support**:
  - Native **HTTP Range 206 Partial Content** for interrupted download resumption and multi-threaded chunking.
  - Full **RFC 5987** compliance via `filename*=UTF-8''` for internationalized and multibyte filenames.
  - Accurate download metrics: increments download counters only on initial chunk requests, preventing range fragmentation skew.
  - Clean `HTTP 410 Gone` semantics for expired, exhausted, or revoked links.
- **Modern Web Drop Portal & Streaming Upload**:
  - Dark-mode drag-and-drop web portal with batch selection, live progress bars, and countdown timers.
  - Zero-heap streaming multipart unpack via `busboy`, streaming 1.0 GB+ files directly to disk.
  - **Automatic Time-Partitioned Archiving**: Uploads are organized into `uploads/YYYY/MM/DD/HHmm/` hierarchies, eliminating flat directory clutter.
  - **Collision Avoidance**: Automatically appends `_YYYYMMDD_HHMMSS` timestamps to duplicate filenames—never overwriting existing assets.
  - **Least Privilege Permissions**: Files are written with restricted `0640` file modes.
- **Dual Interface Modes**:
  - **Native CLI Subcommands**: Seamlessly registered under `openclaw fileserver <subcommand>`.
  - **In-Memory Agent Tools**: Exposes `fileserver_share`, `fileserver_receive`, `fileserver_list`, and `fileserver_revoke` tools directly to AI models without spawning shell child processes.

---

## 🏗️ Architecture

```text
[Browser / External Clients]
         │ (HTTPS 443)
         ▼
[Nginx Reverse Proxy: openclaw.your-domain.com]
   └── location ^~ / ──────────────────►  proxy_pass http://127.0.0.1:18789;
       (The only proxy rule needed)
                                                    │
                                                    ▼
                                          [OpenClaw Gateway (18789)]
                                             ├── WebChat / Control UI
                                             ├── Gateway RPC (/v1, /api)
                                             └── [Fileserver Plugin Routes]
                                                   ├── /d/*       -> Range-resumed download
                                                   ├── /uploads/* -> Web drop portal / streaming upload
                                                   └── /api/share -> REST credentials endpoint
```

---

## 📦 Installation & Setup

### 1. Install via ClawHub (Recommended)

```bash
openclaw plugins install clawhub:@LuisCMerrick/openclaw-plugin-fileserver
```

### 2. Install from Git Source

```bash
openclaw plugins install git:https://github.com/LuisCMerrick/openclaw-plugin-fileserver.git --force
```

### 3. Local Extension Development

```bash
cd ~/.openclaw/extensions/fileserver
npm install --omit=dev && npm run build

# Link local extension into OpenClaw
openclaw plugins install --link ~/.openclaw/extensions/fileserver --force
```

### 4. Enable Plugin

Verify or add the plugin entry in `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "entries": {
      "fileserver": {
        "enabled": true
      }
    }
  }
}
```

Restart the Gateway to apply changes:

```bash
openclaw gateway restart
```

---

## 🌐 Nginx Minimal Reverse Proxy

Because all routes are mounted on the primary Gateway port, standard single-root proxy configurations work out of the box:

```nginx
server {
  listen 80;
  listen 443 ssl;
  server_name openclaw.your-domain.com;

  # SSL configuration...

  location ^~ / {
    proxy_redirect off;
    proxy_pass http://127.0.0.1:18789;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto "https";

    # Streaming file transfer settings
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 1024m;
  }
}
```

---

## 💻 CLI Usage

```bash
# 1. Generate clean download link for a workspace file
openclaw fileserver share [-t 24h] [-m 10] [-i] <filepath>
# Example: openclaw fileserver share -t 2h -m 5 document.pdf

# 2. Create a temporary Web drop portal
openclaw fileserver receive [-t 24h] [-d uploads] [-m 0]
# Example: openclaw fileserver receive -t 12h

# 3. List all active and expired shares / upload channels
openclaw fileserver list

# 4. Revoke a share or upload channel by 8-char code
openclaw fileserver revoke <code>

# 5. Prune expired or revoked records older than 24h
openclaw fileserver prune
```

---

## 🤖 Agent Native Tools

AI agents can directly invoke these structured tools without shell execution:

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `fileserver_share` | `path`, `ttl?`, `max_downloads?`, `inline?` | Generate clean download URL for a workspace file |
| `fileserver_receive` | `dir?`, `ttl?`, `max_uploads?` | Create temporary Web drop portal with time-partitioned destination |
| `fileserver_list` | *(none)* | List all active/expired shares and portals |
| `fileserver_revoke` | `code` | Revoke a share or drop portal by code |

---

## 📄 License

Licensed under the [MIT License](LICENSE).
