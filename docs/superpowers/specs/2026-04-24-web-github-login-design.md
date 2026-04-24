# Web 端 GitHub 登录 — 设计文档

**Date:** 2026-04-24
**Status:** Draft → Review

## 背景

当前 `copilot-api` 启动时若本地无 GitHub token（`~/.local/share/copilot-api/github-token`），`setupGitHubToken()` 会启动 GitHub device flow 并阻塞在终端里要求用户输入 `user_code`。这对容器部署、远程进程或没有 TTY 的场景不友好。

本设计在 dashboard 中加入"通过 web 完成 GitHub 登录"的能力，仅 super-admin 可用。

## 目标

1. 启动时无 GitHub token 不再阻塞，服务正常可用，仅 Copilot 转发端点暂不可用
2. super-admin 可以在 dashboard 里完成完整的 GitHub device flow 登录，无需进入终端
3. super-admin 可以随时重新登录（覆盖现有 token）
4. 普通 admin / user 看不到登录入口，也不能调用相关 API
5. 不引入额外的 GitHub OAuth App 注册（复用现有 device flow + `GITHUB_CLIENT_ID`）

## 非目标

- 不实现 OAuth 授权码 redirect 流程
- 不改变 CLI `auth` / `start` 在 TTY 下的现有 device flow 行为（只解耦"启动时阻塞"这一点）
- 不为普通 admin 增加 GitHub 登录权限

## 架构总览

```
super-admin browser
  ↓ session cookie
/admin/github/*  (Hono routes, sessionMiddleware requireRole=super)
  ↓
DeviceFlowManager (in-memory singleton, src/services/github/device-flow-manager.ts)
  ↓ background polling
GitHub /login/device/code, /login/oauth/access_token
  ↓ on success
writeGithubToken() + state.githubToken = ... + bootstrapCopilotToken()
  ↓
Copilot endpoints (/chat/completions, /embeddings, /models, /v1/messages) become available
```

## 详细设计

### 1. 启动行为变更

**`src/lib/token.ts`**
- `setupGitHubToken(options)` 增加 `optional?: boolean`。当 `optional === true` 且无本地 token、无 `state.githubToken` 时：打印 `consola.warn("GitHub token missing — sign in via dashboard")` 并立即返回，不调用 `getDeviceCode/pollAccessToken`
- 抽出新函数 `bootstrapCopilotToken()`：包含原 `setupCopilotToken()` 的逻辑（取 token + 启动定时器），加模块级 `isBootstrapping` flag 防止重入；首次成功后还要触发 `cacheModels()`
- 抽出 `stopCopilotTokenRefresh()`：清空当前的 `setInterval` 句柄（用于 logout / 重新登录前清理）
- 模块级保存 `refreshTimer: ReturnType<typeof setInterval> | null`

**`src/start.ts`**
- 启动顺序调整：
  ```
  if (options.githubToken) state.githubToken = options.githubToken
  else await setupGitHubToken({ optional: true })

  if (state.githubToken) {
    await bootstrapCopilotToken()
    await cacheModels()
  } else {
    consola.warn("Copilot endpoints disabled until GitHub login completes via dashboard")
  }
  await setupAuthToken()
  ```
- `--claude-code` 选模型流程：若 `state.models` 未准备好，提示用户先在 dashboard 完成登录后再使用 `--claude-code`，跳过该步骤而不是 `invariant` fail
- dashboard 启动 box 文案：在 `state.githubToken` 缺失时增加一行 `"  GitHub: not connected — sign in at /github-auth"`

**Copilot 端点保护（`src/lib/copilot-availability.ts`，新文件）**

提供一个轻量中间件 `requireCopilotReady()`：
```ts
if (!state.copilotToken) {
  return c.json(
    { error: { type: "copilot_unavailable",
               message: "GitHub login required. Visit dashboard to sign in." } },
    503,
  )
}
return next()
```

挂在以下路由前（在 `auth-middleware` 之后）：`/chat/completions`、`/embeddings`、`/models`、`/v1/messages`。

### 2. Device Flow 状态机

**新文件 `src/services/github/device-flow-manager.ts`**

```ts
export type DeviceFlowStatus =
  | "pending" | "success" | "error" | "expired" | "cancelled"

interface DeviceFlow {
  id: string                        // server-side flow_id (uuid)
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: number
  intervalSec: number
  status: DeviceFlowStatus
  error?: string                    // friendly message
  login?: string                    // populated on success
  createdAt: number
  startedBy: number | "super"
}
```

**单例 Map** `flows: Map<string, DeviceFlow>` + `activeFlowId: string | null`。

**API（同模块导出）：**
- `startDeviceFlow(startedBy)`: 若已存在 active pending flow，直接返回它；否则调用 `getDeviceCode()`，生成 uuid，存 map，**后台 fire-and-forget** `runPolling(id)`
- `getFlow(id)`: 直接返回 Map 项（或 undefined）
- `cancelFlow(id)`: 标记 `cancelled`，置 `activeFlowId = null`
- `runPolling(id)`: 内部循环
  - 按 `intervalSec` `await sleep`
  - 调用 GitHub `/login/oauth/access_token`
  - 解析响应 `error` 字段：
    - `authorization_pending` → 继续
    - `slow_down` → `intervalSec += 5`
    - `expired_token` → status=expired，break
    - `access_denied` → status=error，error="User denied access"
    - 其它 → status=error，error=描述
  - 拿到 `access_token`：
    1. `await saveGithubToken(token)`（沿用 `writeGithubToken`）
    2. `state.githubToken = token`
    3. `const user = await getGitHubUser(); flow.login = user.login`
    4. `stopCopilotTokenRefresh()` + `await bootstrapCopilotToken()` + `await cacheModels()`
    5. status=success，`activeFlowId = null`
  - 任何异常：status=error，写入消息
  - 5 分钟后 `setTimeout` 删除该 flow 项

**注意 `pollAccessToken` 的复用：** 现有 `pollAccessToken` 是无限阻塞循环且没有错误细分，不能直接用。新管理器自己实现 polling 循环；可将 GitHub HTTP 请求抽到一个 `requestAccessToken(deviceCode)` 工具函数共享。

### 3. Admin API 端点

**新文件 `src/routes/admin/github-auth.ts`**，挂载到 `adminRoutes.route("/github", adminGithubAuthRoutes)`。

所有路由用 `sessionMiddleware({ requireRole: "super" })`。

| Method | Path | Request | Response |
|---|---|---|---|
| GET  | `/admin/github/status` | — | `{ hasToken: boolean, login: string \| null, copilotReady: boolean, activeFlow: { id, expiresAt } \| null }` |
| POST | `/admin/github/device-flow/start` | `{}` | `{ flow_id, user_code, verification_uri, verification_uri_complete, expires_in, interval }` |
| GET  | `/admin/github/device-flow/:id` | — | `{ status, error, login, expiresAt }` |
| POST | `/admin/github/device-flow/:id/cancel` | — | `{ ok: true }` |
| POST | `/admin/github/logout` | — | `{ ok: true }` — 删除本地 token 文件、清 `state.githubToken/copilotToken/models`、`stopCopilotTokenRefresh()` |

错误使用 `forwardError(c, error)`；输入用 zod 校验。

`GET /status` 中 `login` 在 `state.githubToken` 存在时按需调用 `getGitHubUser()` 并缓存到 `state.githubLogin`（启动时 + 登录成功时也设置该字段，避免每次 status 都打 GitHub）。

### 4. 前端

**新文件 `frontend/src/pages/GithubAuth.tsx`**（路由 `/github-auth`，super-only）。

页面结构：
- **Header**：调用 `/admin/github/status`，显示 `GitHub: connected as {login}` 或 `Not connected`，附 Copilot 状态徽章
- **Body** 三态：
  - **Idle**：按钮 `Sign in to GitHub`（已登录显示 `Re-authenticate GitHub` + 二次确认 dialog）
  - **Active flow**：
    - 大字号 `user_code`（带 Copy 按钮）
    - "Open GitHub" 按钮（`<a href={verification_uri_complete || verification_uri} target="_blank">`）
    - 文案 "Enter the code on GitHub. This page will update automatically."
    - 倒计时（基于 `expiresAt`）
    - `Cancel` 按钮
    - 每 `interval` 秒（默认 5s）轮询 `/admin/github/device-flow/:id`
  - **Result**：
    - success → toast `Signed in as {login}`，3 秒后跳 Overview
    - error / expired / cancelled → 显示原因 + `Try again` 按钮回到 Idle

**`frontend/src/pages/Overview.tsx`**：增加顶部 banner，当 `status.copilotReady === false` 时显示醒目提示。super-admin 看到带链接 `Sign in`，普通角色看到只读文案。

**`frontend/src/App.tsx`**：注册 `/github-auth` 路由 + 角色守卫。侧边栏菜单仅 super 显示 `GitHub Auth` 入口。

**`frontend/src/api/client.ts`**：新增 `githubAuthApi`：`getStatus()`, `startDeviceFlow()`, `getFlow(id)`, `cancelFlow(id)`, `logout()`。

### 5. 安全 & 边界

- `device_code` / `access_token` 全程不返回前端
- 同一时刻全局只允许一个 active pending flow
- `/admin/github/*` 后端硬性 super-admin 校验，前端隐藏只是 UX
- 重新登录前自动 `stopCopilotTokenRefresh()` 防止重复 `setInterval`
- `bootstrapCopilotToken()` 模块级互斥
- Flow 完成 5 分钟后从 Map 移除
- Logout 端点要求 super；执行后立刻删除磁盘 token 文件

### 6. 测试

新增 `tests/`：

- `github-device-flow.test.ts` — mock `globalThis.fetch`：
  - 成功路径：device_code → authorization_pending → access_token → status=success + state 设置
  - 拒绝：access_denied → status=error
  - 过期：expired_token → status=expired
  - slow_down：interval 增加
  - cancel：cancel 后停止 polling
- `admin-github-auth.test.ts` — mock session：
  - super-admin 全部 200
  - admin/user → 403
  - 未登录 → 401
  - 重复 start → 返回同一 flow_id
  - schema 校验
- `copilot-unavailable.test.ts`：
  - `state.copilotToken` 未设置 → `/chat/completions` 返回 503 + `copilot_unavailable`

## 影响清单

**新文件**
- `src/services/github/device-flow-manager.ts`
- `src/routes/admin/github-auth.ts`
- `src/lib/copilot-availability.ts`
- `frontend/src/pages/GithubAuth.tsx`
- `tests/github-device-flow.test.ts`
- `tests/admin-github-auth.test.ts`
- `tests/copilot-unavailable.test.ts`

**修改文件**
- `src/lib/token.ts` — 拆分 + `optional` 选项 + 刷新句柄管理
- `src/lib/state.ts` — 新增 `githubLogin?: string`
- `src/start.ts` — 启动顺序 + claude-code 容错 + dashboard box 文案
- `src/routes/admin/route.ts` — 挂载 github 子路由
- `src/server.ts`（或各 route 文件）— 在 Copilot 路由前加 `requireCopilotReady()`
- `frontend/src/App.tsx` — 路由 + 守卫
- `frontend/src/api/client.ts` — `githubAuthApi`
- `frontend/src/pages/Overview.tsx` — banner

## 开放问题

无（device flow 本身有 GitHub 文档定义的明确状态码；前端轮询间隔与超时由响应中的 `interval`/`expires_in` 给出）。
