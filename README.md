# OpenClaw Fileserver Plugin (`openclaw-plugin-fileserver`)

OpenClaw 官方规范的原生安全文件流转与分发插件。提供优雅的直链下载、断点续传、临时 Web 投递门户、大文件流式解包与时间分层自动归档能力。

---

## 🌟 核心特性

- **单端口网关原生挂载 (Single-Port Gateway)**：
  - 通过 OpenClaw 官方 SDK 的 `api.registerHttpRoute`，直接将 `/d/*`、`/uploads/*` 与 `/api/share` 挂载在网关主 HTTP 服务上；
  - 彻底摆脱传统伴生服务多开端口（如 18790）的弊端；
  - **Nginx 反代仅需保留唯一的根反代 `location ^~ /`**，无需为文件服务维护任何单独的 location 规则。
- **8 位无歧义加密短码**：
  - 采用排除视觉混淆字符（`0, O, 1, l, i`）的 30 位安全字符集；
  - 采用 CSPRNG 密码学伪随机数生成，具备高抗碰撞性与不可预测性。
- **安全沙箱隔离 (`safeResolve`)**：
  - 严格限制在 `allowed_root`（默认为 workspace）沙箱内；
  - 实时通过 `fs.realpath` 解析物理路径，严防路径穿越（`../`）与恶意软链接（Symlink）越权逃逸。
- **完善的下载协议支持**：
  - 支持 **HTTP Range 206 Partial Content** 断点续传与多线程切片直传；
  - 严格遵循 **RFC 5987** 标准，通过 `filename*=UTF-8''` 完美兼容国际化多语言与中文文件名；
  - 精确下载计数：仅在首包/完整下载时计费/计数，续传分片不重复计数；
  - 链接超期、达到下载上限或主动撤销时，均返回语义明确的 `HTTP 410 Gone`。
- **现代化 Web 投递门户与流式上传**：
  - 开箱自带纯深色模式拖拽上传界面，支持批量拖拽、实时进度条与剩余时间倒计时；
  - 零内存堆积流式解包（基于 `busboy`），支持 1.0 GB+ 大文件直接写入磁盘；
  - **自动时间分层归档**：新上传文件自动按 `uploads/YYYY/MM/DD/HHmm/` 建立层级，告别平面目录混乱；
  - **同名避冲**：检测到目标目录同名文件自动追加 `_YYYYMMDD_HHMMSS` 时间戳，绝不覆盖已有资产；
  - **权限收敛**：落盘文件严格以 `0640` 权限安全创建。
- **双模体验**：
  - **CLI 一等公民**：无缝注册为 `openclaw fileserver <subcommand>`；
  - **Agent 内存直调**：注册 `fileserver_share`, `fileserver_receive`, `fileserver_list`, `fileserver_revoke` 原生工具，模型无需派生 shell 子进程。

---

## 🏗️ 架构拓扑

```text
[浏览器 / 外部客户端]
         │ (HTTPS 443)
         ▼
[Nginx 反代 openclaw.your-domain.com]
   └── location ^~ / ──────────────────►  proxy_pass http://127.0.0.1:18789;
       (全站唯一的反向代理规则)
                                                    │
                                                    ▼
                                          [OpenClaw Gateway (18789)]
                                             ├── WebChat / Control UI
                                             ├── Gateway RPC (/v1, /api)
                                             └── [Fileserver 原生插件路由]
                                                   ├── /d/*       -> Range 断点续传下载
                                                   ├── /uploads/* -> Web 投递门户 / 流式上传
                                                   └── /api/share -> REST 凭证生成接口
```

---

## 📦 安装与配置

### 1. 安装插件

克隆或下载本仓库到 OpenClaw 全局扩展目录：

```bash
mkdir -p ~/.openclaw/extensions/fileserver
git clone https://github.com/ming79486/openclaw-plugin-fileserver.git ~/.openclaw/extensions/fileserver
cd ~/.openclaw/extensions/fileserver
npm install --omit=dev
```

### 2. 启用插件

在 `~/.openclaw/openclaw.json` 中确认或加入启用配置：

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

重启 OpenClaw Gateway 即可加载生效：

```bash
openclaw gateway restart
```

---

## 🌐 Nginx 极简反代配置

由于所有路由直接挂载在网关主端口，Nginx 虚拟主机配置无需为文件服务单独开设路由，只需标准的单一 `location ^~ /`：

```nginx
server {
  listen 80;
  listen 443 ssl;
  server_name openclaw.your-domain.com;

  # SSL 证书配置省略...

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

    # 支持流式大文件传输
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 1024m;
  }
}
```

---

## 💻 命令行用法 (CLI Usage)

```bash
# 1. 为工作区文件生成下载直链
openclaw fileserver share [-t 24h] [-m 10] [-i] <filepath>
# 示例：openclaw fileserver share -t 2h -m 5 document.pdf

# 2. 创建一个临时 Web 投递通道
openclaw fileserver receive [-t 24h] [-d uploads] [-m 0]
# 示例：openclaw fileserver receive -t 12h

# 3. 查看当前所有有效/已过期的分享与通道
openclaw fileserver list

# 4. 撤销指定的分享或通道短码
openclaw fileserver revoke <8位短码>

# 5. 清理已过期超过 24 小时或已被撤销的历史死信记录
openclaw fileserver prune
```

---

## 🤖 Agent 原生工具 (Tool Usage)

AI Agent 无需通过 Bash 执行命令行，可直接在上下文以结构化 JSON 调用：

| 工具名 | 参数 | 功能说明 |
| :--- | :--- | :--- |
| `fileserver_share` | `path`, `ttl?`, `max_downloads?`, `inline?` | 为工作区文件生成专属下载直链 |
| `fileserver_receive` | `dir?`, `ttl?`, `max_uploads?` | 创建文件上传通道，自动生成时间子目录 |
| `fileserver_list` | *(无)* | 查询所有分享与通道记录 |
| `fileserver_revoke` | `code` | 依据短码吊销下载链接或上传通道 |

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
