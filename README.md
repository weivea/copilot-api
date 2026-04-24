# Copilot API Proxy

> [!WARNING]
> 本项目是对 GitHub Copilot API 的逆向代理实现，**并非 GitHub 官方支持**，可能因上游变动而随时失效。请自行评估风险。

> [!WARNING]
> **GitHub 安全提示：**
> 过度的自动化或脚本化使用 Copilot（例如高频或批量请求）可能触发 GitHub 的滥用检测系统。
> 你可能会收到 GitHub Security 的警告，进一步的异常活动甚至可能导致 Copilot 访问被临时封禁。
>
> GitHub 禁止将其服务器用于任何过度的自动化批量活动或对其基础设施造成不当负担的行为。
>
> 请阅读：
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> 请负责任地使用本代理，避免账号被限制。

---

**提示：** 如果你已经在使用 [opencode](https://github.com/sst/opencode)，则不需要本项目 —— opencode 原生支持 GitHub Copilot Provider。

---

## 项目简介

一个对 GitHub Copilot API 的逆向代理，将其暴露为 **OpenAI 兼容**和 **Anthropic 兼容**的服务。任何支持 OpenAI Chat Completions API 或 Anthropic Messages API 的工具都可以通过本项目以 GitHub Copilot 作为后端，包括驱动 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)。

本分支在原项目基础上新增了**多 token 鉴权**和**带角色权限的 Web 管理后台**，可在团队/共享部署场景下精细化控制每个使用方的额度与可见性。

## 功能特性

### 兼容性 & 客户端集成
- **OpenAI & Anthropic 双兼容**：同时暴露 OpenAI 风格 (`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`) 和 Anthropic 风格 (`/v1/messages`、`/v1/messages/count_tokens`) 接口。
- **Claude Code 集成**：通过 `--claude-code` 一键生成可直接粘贴的环境变量启动命令。
- **多账号类型支持**：individual / business / enterprise 三种 GitHub Copilot 计划均可使用。

### 多 token 鉴权与配额（新）
- **三级角色模型**：`super`（超级管理员，文件存储）/ `admin`（管理员，可管理普通 token）/ `user`（仅可查看自身）。
- **token 持久化**：除文件保存的超管 token 外，新增 token 通过 SQLite 存储，仅哈希落库（SHA-256，常量时间比对）。
- **每 token 配额**：可配置 RPM、月度 token 上限、终身 token 上限；命中上限时返回带类型的 `429`/`403` JSON 错误。
- **使用计量**：每次请求记录 endpoint、状态码、模型、prompt/completion/total tokens、延迟；支持 1% 概率的过期日志清理。
- **会话隔离**：管理后台使用 HttpOnly Lax Cookie，删除/禁用某 token 会级联清理其会话。

### Web Dashboard（新）
- **静态 SPA**：基于 React + Vite + Recharts，构建产物随 `bun run build` 一并生成，由后端直接托管。
- **登录 / 我 / 退出**：`POST /admin/api/login`、`GET /admin/api/me`、`POST /admin/api/logout`，支持 1 / 7 / 30 天 TTL。
- **Token 管理页**：列表、创建（明文仅显示一次）、改名/限额、禁用、删除、月度/终身计数重置（按角色限制操作）。
- **Usage 页**：按 Me / 全部 / 单 token 切换；支持 hour/day/week/month 桶、Recharts 趋势图、最近请求列表、按 token 汇总。
- **Overview 页**：今日请求 / 今日 token / 月度 / 终身 卡片。
- **Settings 页**：浏览器本地保存默认会话 TTL。

### 运维 & 安全
- **请求日志脱敏**：自带 `redactingLogger` 中间件，自动把 URL 中的 `?key=…` 替换为 `key=REDACTED`。
- **TLS / HTTPS**：内置 certbot 集成，可一键 obtain/renew Let's Encrypt 证书。
- **本地存储 0600**：超管 token、SQLite 文件均以受限权限存储于 `~/.local/share/copilot-api/`。
- **CLI 速率控制**：`--rate-limit`、`--wait`、`--manual` 与多 token 配额并存。


## 环境要求

- [Bun](https://bun.com/) ≥ 1.2.x
- 可用的 GitHub Copilot 订阅（individual / business / enterprise）

## 安装

```sh
bun install
# postinstall 会自动安装 frontend/ 目录下的依赖（仅在缺失时执行）
```

构建（包含前端 dashboard）：

```sh
bun run build
# 产物：dist/main.js + dist/public/{index.html, assets/...}
```

## 快速开始

最简单的方式 —— 一条命令完成 install + build + start：

```sh
git clone https://github.com/ericc-ch/copilot-api.git
cd copilot-api
bun run bootstrap
```

`bootstrap` 等价于 `bun install && bun run build && bun run start`，覆盖从克隆到启动的全流程。

分步执行：

```sh
bun install        # 安装根依赖；postinstall 自动装前端依赖
bun run build      # 编译前端 + 后端，输出到 dist/
bun run start      # 生产模式启动
# 或：bun run dev   # 开发模式（带 watch）
```

启动后控制台会分别输出 dashboard 地址与超管 token：

```
🌐 Usage Viewer: 旧版静态 viewer（外部 GitHub Pages）
📊 Dashboard ready
  URL:   http://localhost:4141/
  Token: see the "Super admin token" line above, or run `bun run show-token`
  Open the URL, then paste the token into the login form.
```

> 首次启动时，需在浏览器完成一次 GitHub OAuth 设备码授权（Copilot 登录）。完成后 token 持久化到 `~/.local/share/copilot-api/`，之后启动即静默。
> 同时会自动生成超管 token 写入 `~/.local/share/copilot-api/auth_token`。首次生成时会打印完整 token 到 banner 中；之后想再次查看可执行 `bun run show-token`。可复制后粘贴到 dashboard 登录表单，也可直接用作 API 鉴权 Bearer token。

### 其他常用一键脚本

| 命令 | 作用 |
| --- | --- |
| `bun run bootstrap` | install + build + start，clone 后一键运行 |
| `bun run setup` | 仅初始化：装前端依赖 + `drizzle-kit generate` |
| `bun run dev:all` | install + setup + dev（带 watch）|
| `bun run build` | 编译前端 + 后端 |

## CLI 命令

| 子命令 | 用途 |
| --- | --- |
| `start` | 启动 Copilot API 服务 + Dashboard（必要时触发 GitHub OAuth） |
| `auth` | 仅运行 GitHub OAuth 设备流，生成 `github_token` 后退出 |
| `auth-token` | 查看或重新生成超管 token（旧版兼容） |
| `check-usage` | 在终端打印当前 GitHub Copilot 使用 / 配额 |
| `debug` | 输出版本、运行时、文件路径、鉴权状态等诊断信息 |

### `start` 命令选项

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--port` | 监听端口 | `4141` | `-p` |
| `--verbose` | 启用详细日志 | `false` | `-v` |
| `--account-type` | 账号类型（individual / business / enterprise） | `individual` | `-a` |
| `--manual` | 每个请求手动确认 | `false` | — |
| `--rate-limit` | 请求间最小间隔（秒） | — | `-r` |
| `--wait` | 命中速率限制时等待而非报错 | `false` | `-w` |
| `--github-token` | 直接传入 GitHub token | — | `-g` |
| `--claude-code` | 生成启动 Claude Code 的环境变量命令 | `false` | `-c` |
| `--no-auth` | 关闭鉴权（同时禁用 dashboard） | `false` | — |
| `--proxy-env` | 从环境变量初始化 HTTP/HTTPS 代理 | `false` | — |
| `--tls-cert` | TLS 证书路径（PEM） | — | — |
| `--tls-key` | TLS 私钥路径（PEM） | — | — |
| `--db-path` | SQLite 数据库文件路径 | `~/.local/share/copilot-api/copilot-api.db` | — |
| `--log-retention-days` | `request_logs` 保留天数 | `90` | — |
| `--no-dashboard` | 禁用 Dashboard 与 `/admin/api` 路由 | `false`（默认启用） | — |

### `auth-token` 命令选项

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| `--regenerate` | 强制重建超管 token | `false` |

### `auth` 命令选项

| 选项 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| `--verbose` | 启用详细日志 | `false` | `-v` |

### `debug` 命令选项

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| `--json` | 以 JSON 输出 | `false` |

## API 端点

### OpenAI 兼容

| 端点 | 方法 | 描述 |
| --- | --- | --- |
| `/v1/chat/completions` | `POST` | 创建聊天补全 |
| `/v1/models` | `GET` | 列出可用模型 |
| `/v1/embeddings` | `POST` | 创建 embedding 向量 |

> 不带 `/v1` 前缀的同名路径也可用（`/chat/completions`、`/models`、`/embeddings`）。

### Anthropic 兼容

| 端点 | 方法 | 描述 |
| --- | --- | --- |
| `/v1/messages` | `POST` | 创建 message 响应 |
| `/v1/messages/count_tokens` | `POST` | 计算消息 token 数 |

### 上游用量信息

| 端点 | 方法 | 描述 |
| --- | --- | --- |
| `/usage` | `GET` | 获取 Copilot 上游配额详情 |
| `/token` | `GET` | 返回当前正在使用的 Copilot token |

### Admin / Dashboard API（新）

均位于 `/admin/api/*`，由 `sessionMiddleware` 守卫，使用 `cpk_session` Cookie 鉴权。

| 端点 | 方法 | 角色 | 描述 |
| --- | --- | --- | --- |
| `/admin/api/login` | `POST` | 任意 token | 用 token 登录，发放会话 Cookie。Body: `{ "key": "cpk-...", "ttl_days": 1 \| 7 \| 30 }` |
| `/admin/api/logout` | `POST` | 任意 | 撤销当前会话 |
| `/admin/api/me` | `GET` | 任意 | 返回当前会话角色 / 名称 / token id |
| `/admin/api/tokens` | `GET` | admin / super | 列出所有 token（不返回 hash 与明文） |
| `/admin/api/tokens` | `POST` | admin / super | 创建 token；明文**仅一次性返回** |
| `/admin/api/tokens/:id` | `PATCH` | admin / super | 改名 / 限额 / 启停（admin 不能改另一 admin） |
| `/admin/api/tokens/:id` | `DELETE` | admin / super | 删除 token + 级联会话 |
| `/admin/api/tokens/:id/reset-monthly` | `POST` | admin / super | 重置月度计数 |
| `/admin/api/tokens/:id/reset-lifetime` | `POST` | super only | 清零终身计数 |
| `/admin/api/usage/summary` | `GET` | 任意 | 用量汇总，`token_id=me \| all \| <id>` |
| `/admin/api/usage/timeseries` | `GET` | 任意（user 仅自己） | 时序数据，需 `from`、`to`、`bucket=hour\|day\|week\|month` |
| `/admin/api/usage/per-token` | `GET` | admin / super | 按 token 汇总 |
| `/admin/api/usage/recent` | `GET` | 任意（user 仅自己） | 最近 N 条请求记录 |

错误响应统一为 `{"error": {"type": "...", "message": "..."}}`，错误类型包括：`auth_error`、`rate_limit_exceeded`、`monthly_quota_exceeded`、`account_quota_exhausted`、`permission_denied`、`bad_request`、`not_found`、`dashboard_disabled`。

## 鉴权与 Token 模型

### 三种角色

| 角色 | 来源 | 默认能力 |
| --- | --- | --- |
| `super` | 文件 `~/.local/share/copilot-api/auth_token`，每次启动加载 | 全部权限，含创建 admin、重置 lifetime |
| `admin` | DB 中 `is_admin=1` 的 token | 可管理普通 token、查看全部用量；不能管理其他 admin |
| `user` | DB 中 `is_admin=0` 的 token | 仅能查看自己的用量 |

### 调用业务 API

```sh
# OpenAI 风格
curl http://localhost:4141/v1/models \
  -H "Authorization: Bearer cpk-your-token"

# Anthropic 风格
curl http://localhost:4141/v1/messages \
  -H "x-api-key: cpk-your-token"
```

### 进入 Dashboard

启动后 banner 中会分别给出 dashboard 地址和超管 token（首次启动会自动打印；后续可执行 `bun run show-token` 再次查看）：

```
📊 Dashboard ready
  URL:   http://localhost:4141/
  Token: see the "Super admin token" line above, or run `bun run show-token`
```

打开 `http://localhost:4141/`，把超管 token 粘贴到登录表单提交即可。出于安全考虑，token 不再通过 URL 查询参数传递（避免泄露到浏览器历史、shell 历史与 HTTP 请求来源头部）。登录成功后 session 写入 HttpOnly Cookie，后续 reload 不需要再次输入。

## 数据库

- 引擎：`bun:sqlite`，开启 WAL 与 `foreign_keys`。
- ORM：`drizzle-orm`，迁移由 `drizzle-kit` 生成（`bun run db:generate`）。
- 默认路径：`~/.local/share/copilot-api/copilot-api.db`（可用 `--db-path` 覆盖），文件权限 `0600`。
- 表：
  - `auth_tokens` — token 元数据 + 限额
  - `request_logs` — 单次请求计量
  - `sessions` — Cookie 会话
  - `usage_resets` — 月度 / 终身 重置审计

每次写日志后有 1% 概率触发 `pruneOldLogs`，删除超过 `--log-retention-days` 的记录；每小时还有一次 `expireOldSessions` 清理过期会话。

## Docker 运行

### 鉴权准备

```sh
# 方式 1：本地直接 auth
bun run dev -- auth

# 方式 2：用 Docker 临时跑 auth
docker run -it -v ~/.local/share/copilot-api:/root/.local/share/copilot-api copilot-api --auth
```

完成后 token 会保存到 `~/.local/share/copilot-api/github_token`。

### 构建镜像

```sh
docker build -t copilot-api .
```

### 运行容器

```sh
docker run -p 4141:4141 \
  -v ~/.local/share/copilot-api:/root/.local/share/copilot-api \
  copilot-api
```

或通过环境变量传入 token：

```sh
docker run -p 4141:4141 -e GH_TOKEN=ghp_xxx copilot-api
```

### Docker Compose

仓库自带 `docker-compose.yml`：

```yaml
services:
  copilot-api:
    build: .
    image: copilot-api
    container_name: copilot-api
    ports:
      - "${PORT:-4141}:4141"
    volumes:
      - ~/.local/share/copilot-api:/root/.local/share/copilot-api
    restart: unless-stopped
```

```sh
docker compose up -d                     # 启动
docker compose logs -f                   # 看日志
docker compose exec copilot-api \
  cat /root/.local/share/copilot-api/auth_token   # 查看超管 token
docker compose down                      # 停止
```

如果只在内网用，想关闭鉴权（同时也会关掉 dashboard）：

```yaml
services:
  copilot-api:
    command: ["--no-auth"]
```

## 与 Claude Code 集成

### 方式 1：交互式

```sh
bun run start --claude-code
```

会让你选择主模型与 small/fast 模型，然后把启动命令复制到剪贴板，粘贴到新终端运行即可。

### 方式 2：手写 `.claude/settings.json`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "cpk-your-auth-token-here",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

> 更多选项见 [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) 与 [IDE 集成](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)。

## HTTPS / TLS

### 准备 certbot

```sh
# Linux
sudo apt install certbot          # Debian / Ubuntu
sudo dnf install certbot          # Fedora / RHEL
# macOS
brew install certbot
# 跨平台
pip install certbot
```

### 一条龙签发

```sh
# 1. 获取证书（会写入 .certs/ 与 copilot-api.config.json）
bun run cert:obtain -- --domain copilot.example.com

# 2. 直接启动，自动启用 HTTPS
bun run start
```

续期：

```sh
bun run cert:renew
```

### 配置文件

读取顺序：

1. 当前目录 `copilot-api.config.json`
2. `~/.local/share/copilot-api/config.json`

示例：

```json
{
  "domain": "copilot.example.com",
  "tls": {
    "cert": ".certs/live/copilot.example.com/fullchain.pem",
    "key": ".certs/live/copilot.example.com/privkey.pem"
  }
}
```

只填 `domain` 时会按 `.certs/` 默认路径推断；CLI `--tls-cert` / `--tls-key` 优先级最高。

### 手动指定证书

```sh
bun run start --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

启用 TLS 后，启动日志会显示证书路径，所有 URL 自动改为 `https://`。

## 源码运行

### 开发

```sh
bun run dev
```

### 生产

```sh
bun run start
```

### 后台运行（Linux）

仓库 `scripts/` 下提供脚本：

```sh
./scripts/start.sh    # 后台启动
./scripts/stop.sh     # 停止
./scripts/restart.sh  # 重启
```

日志输出到 `copilot-api.log`，PID 保存在 `copilot-api.pid`。

### systemd 守护

`/etc/systemd/system/copilot-api.service`:

```ini
[Unit]
Description=Copilot API Proxy
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/copilot-api
ExecStart=/usr/bin/env bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable copilot-api
sudo systemctl start copilot-api
sudo systemctl status copilot-api
journalctl -u copilot-api -f
```

## 常见用法 / Tips

- 想避免触发 GitHub 速率限制：
  - `--manual` 每请求人工确认；
  - `--rate-limit <秒>` 设最小请求间隔；
  - `--wait` 配合 `--rate-limit`，让服务在冷却时挂起而非报错（适合不会自动重试的客户端）。
- 商业 / 企业版 Copilot 用户务必加 `--account-type business` 或 `--account-type enterprise`，参考 [GitHub 官方文档](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization)。
- 多人共享部署时：用超管登录 dashboard → Tokens → New token → 设置 RPM/月度/终身限额 → 把生成的 `cpk-…` token 发给对方使用。token 明文只展示一次，遗失后只能重建。
- 想完全关闭后台与登录入口（同时关掉鉴权）：`--no-auth`。想保留鉴权但不开后台：`--no-dashboard`。

## 项目结构

```
src/
  main.ts                  # CLI 入口
  start.ts                 # start 子命令 + 服务启动流程
  server.ts                # Hono 应用：日志/CORS/admin/business 路由 + SPA
  lib/
    auth-middleware.ts     # 业务 API 多 token + 限额校验
    auth-token.ts          # 超管 token 读写
    auth-token-utils.ts    # generateToken / hashToken / prefixOf
    session.ts             # Cookie + sessionMiddleware
    usage-recorder.ts      # 请求后写入 request_logs + 累计 lifetime
    redacting-logger.ts    # 日志中 ?key= 脱敏
    static-spa.ts          # dist/public 静态托管 + SPA fallback
    state.ts               # 全局运行时状态
  db/
    client.ts              # bun:sqlite + drizzle 初始化
    schema.ts              # auth_tokens / request_logs / sessions / usage_resets
    queries/               # CRUD 封装
  routes/
    chat-completions/      # OpenAI 风格
    embeddings/
    messages/              # Anthropic ↔ OpenAI 翻译
    models/
    token/, usage/         # 上游信息
    admin/                 # auth / tokens / usage 三个 subapp
frontend/                  # Vite + React + Recharts 后台 SPA
drizzle/                   # 自动生成的迁移
```

## 开发常用脚本

```sh
bun run dev                # 热重载启动
bun run build              # 前端 + 后端打包到 dist/
bun run build:frontend     # 仅打包前端
bun test                   # 跑全部 Bun 测试
bun run typecheck          # tsc --noEmit
bun run lint               # eslint
bun run db:generate        # drizzle-kit generate
```
