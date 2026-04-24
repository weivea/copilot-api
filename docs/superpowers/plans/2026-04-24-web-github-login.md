# Web GitHub Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let super-admins complete the GitHub OAuth device flow inside the dashboard so the server can boot without a GitHub token and surface Copilot endpoints as 503 until login completes.

**Architecture:** Refactor token bootstrap so `setupGitHubToken({ optional: true })` no longer blocks at startup. Add an in-memory `DeviceFlowManager` that drives the device flow asynchronously. Expose super-admin-only `/admin/api/github/*` routes to start/poll/cancel/logout flows. Add a `requireCopilotReady()` middleware that returns 503 on `/chat/completions`, `/embeddings`, `/models`, `/v1/*` when no Copilot token is loaded. Add a React `GithubAuth` page plus an Overview banner.

**Tech Stack:** Bun, Hono, TypeScript (strict, no `any`), zod, Drizzle/SQLite, React + react-router-dom for the SPA, `consola` for logging, `bun:test` for tests.

**Spec:** `docs/superpowers/specs/2026-04-24-web-github-login-design.md`

---

## File Structure

**New files**
- `src/lib/copilot-availability.ts` — `requireCopilotReady()` Hono middleware
- `src/services/github/request-access-token.ts` — single-shot wrapper around GitHub `/login/oauth/access_token`
- `src/services/github/device-flow-manager.ts` — singleton state machine that owns the device flow lifecycle
- `src/routes/admin/github-auth.ts` — Hono router for `/admin/api/github/*`
- `frontend/src/pages/GithubAuth.tsx` — dashboard page with Idle/Active/Result states
- `tests/copilot-availability.test.ts`
- `tests/github-device-flow.test.ts`
- `tests/admin-github-auth.test.ts`

**Modified files**
- `src/lib/state.ts` — add `githubLogin?: string`
- `src/lib/token.ts` — split out `bootstrapCopilotToken` / `stopCopilotTokenRefresh`, add `optional` flag, expose `clearGithubToken`
- `src/start.ts` — non-blocking startup ordering + dashboard box updates + `--claude-code` graceful skip
- `src/server.ts` — mount `requireCopilotReady()` on Copilot routes
- `src/routes/admin/route.ts` — mount `adminGithubAuthRoutes`
- `frontend/src/App.tsx` — register `/github-auth` route + super-only guard + nav entry
- `frontend/src/api/client.ts` — add `githubAuthApi`
- `frontend/src/types.ts` — add types for GitHub auth responses
- `frontend/src/pages/Overview.tsx` — connection-state banner

---

## Task 1: Add `githubLogin` to global state

**Files:**
- Modify: `src/lib/state.ts`

- [ ] **Step 1: Edit state interface and singleton**

Add the field next to the other GitHub fields and to the singleton initializer.

```ts
export interface State {
  githubToken?: string
  githubLogin?: string
  copilotToken?: string
  // …existing fields unchanged
}

export const state: State = {
  // existing values unchanged
}
```

(`githubLogin` is optional so no initializer change is required, but verify the file still type-checks.)

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/state.ts
git commit -m "feat(state): add optional githubLogin to global state"
```

---

## Task 2: Refactor token bootstrap into reusable functions

**Files:**
- Modify: `src/lib/token.ts`

This task does NOT change behavior at startup yet — it just exposes the building blocks.

- [ ] **Step 1: Edit `src/lib/token.ts`**

Replace the file with:

```ts
import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

export const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export async function deleteGithubTokenFile(): Promise<void> {
  try {
    await fs.unlink(PATHS.GITHUB_TOKEN_PATH)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
let bootstrapping = false

export function stopCopilotTokenRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

export async function bootstrapCopilotToken(): Promise<void> {
  if (bootstrapping) return
  bootstrapping = true
  try {
    stopCopilotTokenRefresh()
    const { token, refresh_in } = await getCopilotToken()
    state.copilotToken = token
    consola.debug("GitHub Copilot Token fetched successfully!")
    if (state.showToken) consola.info("Copilot token:", token)

    const refreshInterval = (refresh_in - 60) * 1000
    refreshTimer = setInterval(async () => {
      consola.debug("Refreshing Copilot token")
      try {
        const { token } = await getCopilotToken()
        state.copilotToken = token
        consola.debug("Copilot token refreshed")
        if (state.showToken) consola.info("Refreshed Copilot token:", token)
      } catch (error) {
        consola.error("Failed to refresh Copilot token:", error)
      }
    }, refreshInterval)
  } finally {
    bootstrapping = false
  }
}

// Backwards-compatible alias used by `auth` and `check-usage` CLI commands.
export const setupCopilotToken = bootstrapCopilotToken

interface SetupGitHubTokenOptions {
  force?: boolean
  optional?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken().catch(() => "")
    const trimmed = githubToken.trim()

    if (trimmed && !options?.force) {
      state.githubToken = trimmed
      if (state.showToken) consola.info("GitHub token:", trimmed)
      await logUser()
      return
    }

    if (options?.optional) {
      consola.warn("GitHub token missing — sign in via dashboard")
      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) consola.info("GitHub token:", token)
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }
    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function clearGithubToken(): Promise<void> {
  stopCopilotTokenRefresh()
  await deleteGithubTokenFile()
  state.githubToken = undefined
  state.githubLogin = undefined
  state.copilotToken = undefined
  state.models = undefined
}

async function logUser() {
  const user = await getGitHubUser()
  state.githubLogin = user.login
  consola.info(`Logged in as ${user.login}`)
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: passes (no `any`, no unused imports).

- [ ] **Step 3: Run existing tests**

Run: `bun test`
Expected: all green (behavior of `setupGitHubToken` without `optional` is unchanged because we only added a new branch behind a flag).

- [ ] **Step 4: Commit**

```bash
git add src/lib/token.ts
git commit -m "refactor(token): split copilot bootstrap and add optional/clear helpers"
```

---

## Task 3: Make startup non-blocking when GitHub token is missing

**Files:**
- Modify: `src/start.ts`

- [ ] **Step 1: Update startup ordering**

Locate the block (around lines 65–80):

```ts
if (options.githubToken) {
  state.githubToken = options.githubToken
  consola.info("Using provided GitHub token")
} else {
  await setupGitHubToken()
}

await setupCopilotToken()
await cacheModels()
await setupAuthToken()
```

Replace with:

```ts
if (options.githubToken) {
  state.githubToken = options.githubToken
  consola.info("Using provided GitHub token")
} else {
  await setupGitHubToken({ optional: true })
}

if (state.githubToken) {
  await bootstrapCopilotToken()
  await cacheModels()
} else {
  consola.warn(
    "Copilot endpoints disabled until GitHub login completes via dashboard",
  )
}
await setupAuthToken()
```

Update the import line accordingly:

```ts
import { bootstrapCopilotToken, setupGitHubToken } from "./lib/token"
```

- [ ] **Step 2: Make `--claude-code` skip gracefully when no models**

Replace the existing `if (options.claudeCode) { invariant(state.models, …) … }` block so the `invariant` becomes a guard:

```ts
if (options.claudeCode) {
  if (!state.models) {
    consola.warn(
      "Skipping --claude-code setup: GitHub login not completed. Sign in via dashboard, then rerun with --claude-code.",
    )
  } else {
    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )
    // …keep the rest of the original block exactly as-is
  }
}
```

(Preserve the entire existing block under the `else` branch — model select, small model select, env script generation, clipboard logic.)

- [ ] **Step 3: Update dashboard box to surface GitHub status**

Replace the existing `if (state.dashboardEnabled)` block with:

```ts
if (state.dashboardEnabled) {
  const lines =
    state.authEnabled ?
      [
        "📊 Dashboard ready",
        `  URL:   ${serverUrl}/`,
        `  Token: see the "Super admin token" line above, or rerun with --show-token`,
        "  Open the URL, then paste the token into the login form.",
      ]
    : ["📊 Dashboard ready", `  URL:   ${serverUrl}/`, "  Auth: disabled"]
  if (!state.githubToken) {
    lines.push("  GitHub: not connected — sign in at /github-auth")
  }
  consola.box(lines.join("\n"))
}
```

Also remove the line that prints `Available models` when models aren't loaded:

```ts
if (state.models) {
  consola.info(
    `Available models: \n${state.models.data.map((model) => `- ${model.id}`).join("\n")}`,
  )
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: passes. `tiny-invariant` import may now be unused — remove it if so.

- [ ] **Step 5: Smoke test startup**

Temporarily move any existing token aside and verify the server boots:

```bash
mv ~/.local/share/copilot-api/github-token /tmp/github-token-backup 2>/dev/null || true
bun run dev &
sleep 3
curl -s http://localhost:4141/healthz
kill %1
mv /tmp/github-token-backup ~/.local/share/copilot-api/github-token 2>/dev/null || true
```

Expected: `ok`, no crash, log line `"Copilot endpoints disabled until GitHub login completes"`.

- [ ] **Step 6: Commit**

```bash
git add src/start.ts
git commit -m "feat(start): boot without GitHub token, defer Copilot bootstrap"
```

---

## Task 4: Add `requireCopilotReady` middleware (test first)

**Files:**
- Create: `src/lib/copilot-availability.ts`
- Test: `tests/copilot-availability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/copilot-availability.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { requireCopilotReady } from "../src/lib/copilot-availability"
import { state } from "../src/lib/state"

beforeEach(() => {
  state.copilotToken = undefined
})

function makeApp(): Hono {
  const app = new Hono()
  app.use("/protected/*", requireCopilotReady())
  app.post("/protected/echo", (c) => c.json({ ok: true }))
  return app
}

describe("requireCopilotReady", () => {
  test("returns 503 with copilot_unavailable when no token", async () => {
    const app = makeApp()
    const res = await app.request("/protected/echo", { method: "POST" })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("copilot_unavailable")
  })

  test("passes through when token is set", async () => {
    state.copilotToken = "abc"
    const app = makeApp()
    const res = await app.request("/protected/echo", { method: "POST" })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/copilot-availability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the middleware**

Create `src/lib/copilot-availability.ts`:

```ts
import type { MiddlewareHandler } from "hono"

import { state } from "./state"

export function requireCopilotReady(): MiddlewareHandler {
  return async (c, next) => {
    if (!state.copilotToken) {
      return c.json(
        {
          error: {
            type: "copilot_unavailable",
            message:
              "GitHub login required. Visit dashboard to sign in.",
          },
        },
        503,
      )
    }
    return next()
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/copilot-availability.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copilot-availability.ts tests/copilot-availability.test.ts
git commit -m "feat(server): add requireCopilotReady middleware"
```

---

## Task 5: Wire `requireCopilotReady` into Copilot routes

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Edit `src/server.ts`**

Add the import:

```ts
import { requireCopilotReady } from "./lib/copilot-availability"
```

Replace the route mounting block with explicit middleware:

```ts
server.route("/admin/api", adminRoutes)

server.use(authMiddleware())
server.use(usageRecorder())

server.use("/chat/completions/*", requireCopilotReady())
server.use("/models/*", requireCopilotReady())
server.use("/embeddings/*", requireCopilotReady())
server.use("/token", requireCopilotReady())
server.use("/v1/*", requireCopilotReady())

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/token", tokenRoute)

server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/messages", messageRoutes)
```

(Hono `app.use("/path/*", mw)` registers the middleware against the prefix; it must appear BEFORE the corresponding `app.route(...)` to take effect on those routes.)

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: all green (existing tests that hit Copilot routes set `state.copilotToken` via mocks; verify and adjust if any test fails — set `state.copilotToken = "x"` in their `beforeEach`).

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): gate Copilot routes on requireCopilotReady"
```

---

## Task 6: GitHub access-token request helper (test first)

**Files:**
- Create: `src/services/github/request-access-token.ts`

- [ ] **Step 1: Implement the helper**

This is small enough to skip a dedicated unit test (it's a thin fetch wrapper exercised end-to-end by Task 7's tests). Create the file:

```ts
import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"

export interface AccessTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

export async function requestAccessToken(
  deviceCode: string,
): Promise<AccessTokenResponse> {
  const response = await fetch(
    `${GITHUB_BASE_URL}/login/oauth/access_token`,
    {
      method: "POST",
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
  )
  if (!response.ok) {
    return { error: "http_error", error_description: await response.text() }
  }
  return (await response.json()) as AccessTokenResponse
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/services/github/request-access-token.ts
git commit -m "feat(github): add single-shot requestAccessToken helper"
```

---

## Task 7: Device flow manager (test first)

**Files:**
- Create: `src/services/github/device-flow-manager.ts`
- Test: `tests/github-device-flow.test.ts`

This module owns: starting device flow, polling in the background, transitioning state, and triggering Copilot bootstrap on success.

- [ ] **Step 1: Write the failing tests**

Create `tests/github-device-flow.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import {
  __resetDeviceFlowsForTest,
  cancelFlow,
  getFlow,
  startDeviceFlow,
} from "../src/services/github/device-flow-manager"

const ORIGINAL_FETCH = globalThis.fetch
let bootstrapCalled = 0

interface QueueEntry {
  match: (url: string, init?: RequestInit) => boolean
  respond: () => Response | Promise<Response>
}

let queue: Array<QueueEntry> = []

function enqueue(entry: QueueEntry) {
  queue.push(entry)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  __resetDeviceFlowsForTest()
  state.githubToken = undefined
  state.githubLogin = undefined
  state.copilotToken = undefined
  bootstrapCalled = 0
  queue = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const next = queue.shift()
    if (!next || !next.match(url, init)) {
      throw new Error(`Unexpected fetch ${url}`)
    }
    return next.respond()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

async function tick(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

describe("device flow manager", () => {
  test("happy path: pending → success populates state", async () => {
    enqueue({
      match: (u) => u.endsWith("/login/device/code"),
      respond: () =>
        jsonResponse({
          device_code: "DCODE",
          user_code: "USER-CODE",
          verification_uri: "https://github.com/login/device",
          verification_uri_complete:
            "https://github.com/login/device?user_code=USER-CODE",
          expires_in: 900,
          interval: 0, // make polling immediate for the test
        }),
    })
    enqueue({
      match: (u) => u.endsWith("/login/oauth/access_token"),
      respond: () => jsonResponse({ error: "authorization_pending" }),
    })
    enqueue({
      match: (u) => u.endsWith("/login/oauth/access_token"),
      respond: () =>
        jsonResponse({ access_token: "GH_TOKEN", token_type: "bearer" }),
    })
    enqueue({
      match: (u) => u.endsWith("/user"),
      respond: () => jsonResponse({ login: "octocat" }),
    })
    enqueue({
      match: (u) => u.endsWith("/copilot_internal/v2/token"),
      respond: () =>
        jsonResponse({ token: "COP_TOKEN", expires_at: 0, refresh_in: 1800 }),
    })

    const flow = await startDeviceFlow("super")
    expect(flow.userCode).toBe("USER-CODE")
    expect(flow.status).toBe("pending")

    // Wait for background polling + bootstrap
    for (let i = 0; i < 50; i++) {
      await tick(20)
      const cur = getFlow(flow.id)
      if (cur && cur.status === "success") break
    }
    const final = getFlow(flow.id)
    expect(final?.status).toBe("success")
    expect(final?.login).toBe("octocat")
    expect(state.githubToken).toBe("GH_TOKEN")
    expect(state.githubLogin).toBe("octocat")
    expect(state.copilotToken).toBe("COP_TOKEN")
  })

  test("access_denied marks flow as error", async () => {
    enqueue({
      match: (u) => u.endsWith("/login/device/code"),
      respond: () =>
        jsonResponse({
          device_code: "X",
          user_code: "U",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        }),
    })
    enqueue({
      match: (u) => u.endsWith("/login/oauth/access_token"),
      respond: () => jsonResponse({ error: "access_denied" }),
    })

    const flow = await startDeviceFlow("super")
    for (let i = 0; i < 30; i++) {
      await tick(20)
      if (getFlow(flow.id)?.status !== "pending") break
    }
    expect(getFlow(flow.id)?.status).toBe("error")
  })

  test("expired_token marks flow as expired", async () => {
    enqueue({
      match: (u) => u.endsWith("/login/device/code"),
      respond: () =>
        jsonResponse({
          device_code: "X",
          user_code: "U",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        }),
    })
    enqueue({
      match: (u) => u.endsWith("/login/oauth/access_token"),
      respond: () => jsonResponse({ error: "expired_token" }),
    })

    const flow = await startDeviceFlow("super")
    for (let i = 0; i < 30; i++) {
      await tick(20)
      if (getFlow(flow.id)?.status !== "pending") break
    }
    expect(getFlow(flow.id)?.status).toBe("expired")
  })

  test("cancel stops the flow", async () => {
    enqueue({
      match: (u) => u.endsWith("/login/device/code"),
      respond: () =>
        jsonResponse({
          device_code: "X",
          user_code: "U",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        }),
    })
    // Provide an authorization_pending so polling won't crash if it races
    enqueue({
      match: (u) => u.endsWith("/login/oauth/access_token"),
      respond: () => jsonResponse({ error: "authorization_pending" }),
    })

    const flow = await startDeviceFlow("super")
    cancelFlow(flow.id)
    expect(getFlow(flow.id)?.status).toBe("cancelled")
  })

  test("repeat start while pending returns same flow", async () => {
    enqueue({
      match: (u) => u.endsWith("/login/device/code"),
      respond: () =>
        jsonResponse({
          device_code: "X",
          user_code: "U",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 0,
        }),
    })
    enqueue({
      match: (u) => u.endsWith("/login/oauth/access_token"),
      respond: () => jsonResponse({ error: "authorization_pending" }),
    })

    const a = await startDeviceFlow("super")
    const b = await startDeviceFlow("super")
    expect(b.id).toBe(a.id)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/github-device-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `device-flow-manager.ts`**

Create `src/services/github/device-flow-manager.ts`:

```ts
import consola from "consola"
import { randomUUID } from "node:crypto"

import { state } from "~/lib/state"
import {
  bootstrapCopilotToken,
  stopCopilotTokenRefresh,
  writeGithubToken,
} from "~/lib/token"
import { cacheModels } from "~/lib/utils"

import { getDeviceCode } from "./get-device-code"
import { getGitHubUser } from "./get-user"
import { requestAccessToken } from "./request-access-token"

export type DeviceFlowStatus =
  | "pending"
  | "success"
  | "error"
  | "expired"
  | "cancelled"

export interface DeviceFlow {
  id: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: number
  intervalSec: number
  status: DeviceFlowStatus
  error?: string
  login?: string
  createdAt: number
  startedBy: number | "super"
}

const flows = new Map<string, DeviceFlow>()
let activeFlowId: string | null = null

const CLEANUP_DELAY_MS = 5 * 60 * 1000

export function getFlow(id: string): DeviceFlow | undefined {
  return flows.get(id)
}

export function getActiveFlow(): DeviceFlow | undefined {
  return activeFlowId ? flows.get(activeFlowId) : undefined
}

export function cancelFlow(id: string): void {
  const flow = flows.get(id)
  if (!flow) return
  if (flow.status === "pending") {
    flow.status = "cancelled"
  }
  if (activeFlowId === id) activeFlowId = null
  scheduleCleanup(id)
}

export async function startDeviceFlow(
  startedBy: DeviceFlow["startedBy"],
): Promise<DeviceFlow> {
  const existing = getActiveFlow()
  if (existing && existing.status === "pending") return existing

  const dc = await getDeviceCode()
  const flow: DeviceFlow = {
    id: randomUUID(),
    userCode: dc.user_code,
    verificationUri: dc.verification_uri,
    verificationUriComplete: (dc as { verification_uri_complete?: string })
      .verification_uri_complete,
    expiresAt: Date.now() + dc.expires_in * 1000,
    intervalSec: dc.interval,
    status: "pending",
    createdAt: Date.now(),
    startedBy,
  }
  flows.set(flow.id, flow)
  activeFlowId = flow.id

  void runPolling(flow.id, dc.device_code)
  return flow
}

async function runPolling(id: string, deviceCode: string): Promise<void> {
  const flow = flows.get(id)
  if (!flow) return

  while (true) {
    const current = flows.get(id)
    if (!current || current.status !== "pending") return

    if (Date.now() > current.expiresAt) {
      current.status = "expired"
      finalize(id)
      return
    }

    if (current.intervalSec > 0) {
      await sleep(current.intervalSec * 1000)
    } else {
      // Yield once so cancel() can interleave even with interval=0 (tests).
      await sleep(0)
    }

    const recheck = flows.get(id)
    if (!recheck || recheck.status !== "pending") return

    let resp: Awaited<ReturnType<typeof requestAccessToken>>
    try {
      resp = await requestAccessToken(deviceCode)
    } catch (err) {
      recheck.status = "error"
      recheck.error = err instanceof Error ? err.message : String(err)
      finalize(id)
      return
    }

    if (resp.access_token) {
      try {
        await writeGithubToken(resp.access_token)
        state.githubToken = resp.access_token
        const user = await getGitHubUser()
        state.githubLogin = user.login
        recheck.login = user.login
        stopCopilotTokenRefresh()
        await bootstrapCopilotToken()
        await cacheModels()
        recheck.status = "success"
      } catch (err) {
        consola.error("Failed to finalize GitHub login:", err)
        recheck.status = "error"
        recheck.error =
          err instanceof Error ? err.message : "Bootstrap failed"
      }
      finalize(id)
      return
    }

    switch (resp.error) {
      case "authorization_pending":
        continue
      case "slow_down":
        recheck.intervalSec += 5
        continue
      case "expired_token":
        recheck.status = "expired"
        finalize(id)
        return
      case "access_denied":
        recheck.status = "error"
        recheck.error = "User denied access"
        finalize(id)
        return
      default:
        recheck.status = "error"
        recheck.error = resp.error_description ?? resp.error ?? "Unknown error"
        finalize(id)
        return
    }
  }
}

function finalize(id: string): void {
  if (activeFlowId === id) activeFlowId = null
  scheduleCleanup(id)
}

function scheduleCleanup(id: string): void {
  setTimeout(() => {
    flows.delete(id)
  }, CLEANUP_DELAY_MS).unref?.()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function __resetDeviceFlowsForTest(): void {
  flows.clear()
  activeFlowId = null
}
```

Note: the existing `getDeviceCode` response interface does not declare `verification_uri_complete`; the optional access via cast is intentional. If you prefer, extend `DeviceCodeResponse` in `get-device-code.ts` to include `verification_uri_complete?: string` and drop the cast.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/github-device-flow.test.ts`
Expected: all 5 tests pass. If `cacheModels` fails because no models endpoint is mocked, also enqueue a `/models` response in the happy-path test, OR temporarily mock `cacheModels`. Simpler: extend the happy-path test queue with one more entry:

```ts
enqueue({
  match: (u) => u.includes("/models"),
  respond: () => jsonResponse({ data: [] }),
})
```

(Place it after the copilot-token entry.) Re-run tests until green.

- [ ] **Step 5: Commit**

```bash
git add src/services/github/device-flow-manager.ts tests/github-device-flow.test.ts
git commit -m "feat(github): add device flow manager with background polling"
```

---

## Task 8: Admin GitHub auth routes (test first)

**Files:**
- Create: `src/routes/admin/github-auth.ts`
- Modify: `src/routes/admin/route.ts`
- Test: `tests/admin-github-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/admin-github-auth.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { hashToken } from "../src/lib/auth-token-utils"
import { state } from "../src/lib/state"
import { adminAuthRoutes } from "../src/routes/admin/auth"
import { adminGithubAuthRoutes } from "../src/routes/admin/github-auth"
import { __resetDeviceFlowsForTest } from "../src/services/github/device-flow-manager"
import { makeTestDb } from "./helpers/test-db"

const SUPER =
  "cpk-super000000000000000000000000000000000000000000000000000000000000"

const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
  state.githubToken = undefined
  state.githubLogin = undefined
  state.copilotToken = undefined
  __resetDeviceFlowsForTest()
  globalThis.fetch = ORIGINAL_FETCH
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api", adminAuthRoutes)
  app.route("/admin/api/github", adminGithubAuthRoutes)
  return app
}

async function loginAsSuper(app: Hono): Promise<string> {
  const res = await app.request("/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: SUPER, ttl_days: 1 }),
  })
  const cookie = res.headers.get("set-cookie") ?? ""
  return cookie.split(";")[0]
}

describe("admin github auth routes", () => {
  test("status without auth → 401", async () => {
    const app = makeApp()
    const res = await app.request("/admin/api/github/status")
    expect(res.status).toBe(401)
  })

  test("status as super returns connection info", async () => {
    const app = makeApp()
    const cookie = await loginAsSuper(app)
    const res = await app.request("/admin/api/github/status", {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      hasToken: boolean
      copilotReady: boolean
    }
    expect(body.hasToken).toBe(false)
    expect(body.copilotReady).toBe(false)
  })

  test("start device flow returns user_code", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          device_code: "D",
          user_code: "USER",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch

    const app = makeApp()
    const cookie = await loginAsSuper(app)
    const res = await app.request("/admin/api/github/device-flow/start", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { flow_id: string; user_code: string }
    expect(body.user_code).toBe("USER")
    expect(body.flow_id.length).toBeGreaterThan(0)
  })

  test("get device-flow by id returns status", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          device_code: "D",
          user_code: "USER",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch

    const app = makeApp()
    const cookie = await loginAsSuper(app)
    const start = await app.request("/admin/api/github/device-flow/start", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    const { flow_id } = (await start.json()) as { flow_id: string }

    const res = await app.request(
      `/admin/api/github/device-flow/${flow_id}`,
      { headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe("pending")
  })

  test("non-super admin token gets 403", async () => {
    // Create an admin (not super) token via DB and use it.
    const { createAuthToken } = await import(
      "../src/db/queries/auth-tokens"
    )
    const adminPlain =
      "cpk-admin000000000000000000000000000000000000000000000000000000000"
    await createAuthToken({
      name: "admin",
      tokenHash: hashToken(adminPlain),
      tokenPrefix: "cpk-admi",
      isAdmin: true,
    })
    const app = makeApp()
    const loginRes = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: adminPlain, ttl_days: 1 }),
    })
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]
    const res = await app.request("/admin/api/github/status", {
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/admin-github-auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

Create `src/routes/admin/github-auth.ts`:

```ts
import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { sessionMiddleware } from "~/lib/session"
import { state } from "~/lib/state"
import { clearGithubToken } from "~/lib/token"
import {
  cancelFlow,
  getActiveFlow,
  getFlow,
  startDeviceFlow,
} from "~/services/github/device-flow-manager"

export const adminGithubAuthRoutes = new Hono()

adminGithubAuthRoutes.use("*", sessionMiddleware({ requireRole: "super" }))

adminGithubAuthRoutes.get("/status", (c) => {
  const active = getActiveFlow()
  return c.json({
    hasToken: Boolean(state.githubToken),
    login: state.githubLogin ?? null,
    copilotReady: Boolean(state.copilotToken),
    activeFlow:
      active && active.status === "pending" ?
        { id: active.id, expiresAt: active.expiresAt }
      : null,
  })
})

adminGithubAuthRoutes.post("/device-flow/start", async (c) => {
  try {
    const flow = await startDeviceFlow("super")
    return c.json({
      flow_id: flow.id,
      user_code: flow.userCode,
      verification_uri: flow.verificationUri,
      verification_uri_complete: flow.verificationUriComplete ?? null,
      expires_in: Math.max(0, Math.floor((flow.expiresAt - Date.now()) / 1000)),
      interval: flow.intervalSec,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

adminGithubAuthRoutes.get("/device-flow/:id", (c) => {
  const flow = getFlow(c.req.param("id"))
  if (!flow) {
    return c.json(
      { error: { type: "not_found", message: "Flow not found" } },
      404,
    )
  }
  return c.json({
    status: flow.status,
    error: flow.error ?? null,
    login: flow.login ?? null,
    expiresAt: flow.expiresAt,
  })
})

adminGithubAuthRoutes.post("/device-flow/:id/cancel", (c) => {
  cancelFlow(c.req.param("id"))
  return c.json({ ok: true })
})

adminGithubAuthRoutes.post("/logout", async (c) => {
  await clearGithubToken()
  return c.json({ ok: true })
})
```

- [ ] **Step 4: Mount the routes**

Edit `src/routes/admin/route.ts`:

```ts
import { Hono } from "hono"

import { adminAuthRoutes } from "./auth"
import { adminGithubAuthRoutes } from "./github-auth"
import { adminTokensRoutes } from "./tokens"
import { adminUsageRoutes } from "./usage"

export const adminRoutes = new Hono()

adminRoutes.route("/", adminAuthRoutes)
adminRoutes.route("/github", adminGithubAuthRoutes)
adminRoutes.route("/tokens", adminTokensRoutes)
adminRoutes.route("/usage", adminUsageRoutes)
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test tests/admin-github-auth.test.ts`
Expected: 5 passing.

- [ ] **Step 6: Run full test suite**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin/github-auth.ts src/routes/admin/route.ts tests/admin-github-auth.test.ts
git commit -m "feat(admin): add /admin/api/github routes (super-admin only)"
```

---

## Task 9: Frontend types + API client

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: Add types**

Append to `frontend/src/types.ts`:

```ts
export interface GithubAuthStatus {
  hasToken: boolean
  login: string | null
  copilotReady: boolean
  activeFlow: { id: string; expiresAt: number } | null
}

export interface DeviceFlowStart {
  flow_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string | null
  expires_in: number
  interval: number
}

export type DeviceFlowStatus =
  | "pending"
  | "success"
  | "error"
  | "expired"
  | "cancelled"

export interface DeviceFlowState {
  status: DeviceFlowStatus
  error: string | null
  login: string | null
  expiresAt: number
}
```

- [ ] **Step 2: Add API client methods**

In `frontend/src/api/client.ts`, add the import and module:

```ts
import type {
  // …existing
  DeviceFlowStart,
  DeviceFlowState,
  GithubAuthStatus,
} from "../types"
```

Append to the `api` object:

```ts
  githubStatus: () => request<GithubAuthStatus>("/github/status"),
  startGithubFlow: () =>
    request<DeviceFlowStart>("/github/device-flow/start", { method: "POST", body: "{}" }),
  getGithubFlow: (id: string) =>
    request<DeviceFlowState>(`/github/device-flow/${id}`),
  cancelGithubFlow: (id: string) =>
    request<{ ok: true }>(`/github/device-flow/${id}/cancel`, { method: "POST" }),
  githubLogout: () => request<{ ok: true }>("/github/logout", { method: "POST" }),
```

- [ ] **Step 3: Typecheck frontend**

Run: `cd frontend && bun run build` (or whatever the project uses) — verify no TS errors. If frontend has its own typecheck script, prefer that.

Run from repo root: `bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts
git commit -m "feat(frontend): add github auth types and api client methods"
```

---

## Task 10: Frontend `GithubAuth` page

**Files:**
- Create: `frontend/src/pages/GithubAuth.tsx`

- [ ] **Step 1: Implement the page**

Create `frontend/src/pages/GithubAuth.tsx`:

```tsx
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import { api } from "../api/client"
import type {
  DeviceFlowStart,
  DeviceFlowState,
  GithubAuthStatus,
} from "../types"

type View =
  | { kind: "idle" }
  | { kind: "active"; flow: DeviceFlowStart; state: DeviceFlowState }
  | { kind: "result"; state: DeviceFlowState }

export function GithubAuth() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<GithubAuthStatus | null>(null)
  const [view, setView] = useState<View>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshStatus = async () => {
    try {
      setStatus(await api.githubStatus())
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void refreshStatus()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const startFlow = async () => {
    setError(null)
    try {
      const flow = await api.startGithubFlow()
      const initial: DeviceFlowState = {
        status: "pending",
        error: null,
        login: null,
        expiresAt: Date.now() + flow.expires_in * 1000,
      }
      setView({ kind: "active", flow, state: initial })
      const intervalMs = Math.max(2, flow.interval) * 1000
      pollRef.current = setInterval(async () => {
        try {
          const next = await api.getGithubFlow(flow.flow_id)
          setView((v) =>
            v.kind === "active" ? { ...v, state: next } : v,
          )
          if (next.status !== "pending") {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setView({ kind: "result", state: next })
            await refreshStatus()
            if (next.status === "success") {
              setTimeout(() => navigate("/overview"), 2000)
            }
          }
        } catch (e) {
          setError(String(e))
        }
      }, intervalMs)
    } catch (e) {
      setError(String(e))
    }
  }

  const cancel = async () => {
    if (view.kind !== "active") return
    await api.cancelGithubFlow(view.flow.flow_id)
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
    setView({ kind: "idle" })
    await refreshStatus()
  }

  const logout = async () => {
    if (!confirm("Disconnect GitHub? Copilot endpoints will stop working until you sign in again.")) return
    await api.githubLogout()
    await refreshStatus()
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
  }

  return (
    <div className="page">
      <h1>GitHub Authentication</h1>

      {status && (
        <div className="card">
          <div>
            <strong>GitHub:</strong>{" "}
            {status.hasToken
              ? `Connected as ${status.login ?? "(unknown)"}`
              : "Not connected"}
          </div>
          <div>
            <strong>Copilot:</strong>{" "}
            {status.copilotReady ? "Ready" : "Unavailable"}
          </div>
          {status.hasToken && (
            <button onClick={logout}>Disconnect GitHub</button>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {view.kind === "idle" && (
        <button onClick={startFlow}>
          {status?.hasToken ? "Re-authenticate GitHub" : "Sign in to GitHub"}
        </button>
      )}

      {view.kind === "active" && (
        <div className="card">
          <p>Enter this code on GitHub. This page will update automatically.</p>
          <div className="user-code">
            <code style={{ fontSize: "2rem", letterSpacing: "0.2em" }}>
              {view.flow.user_code}
            </code>
            <button onClick={() => copy(view.flow.user_code)}>Copy</button>
          </div>
          <a
            href={
              view.flow.verification_uri_complete ??
              view.flow.verification_uri
            }
            target="_blank"
            rel="noreferrer"
          >
            <button>Open GitHub</button>
          </a>
          <button onClick={cancel}>Cancel</button>
        </div>
      )}

      {view.kind === "result" && (
        <div className="card">
          {view.state.status === "success" && (
            <div>Signed in as {view.state.login}. Redirecting…</div>
          )}
          {view.state.status !== "success" && (
            <>
              <div>Login {view.state.status}: {view.state.error}</div>
              <button onClick={() => setView({ kind: "idle" })}>
                Try again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/GithubAuth.tsx
git commit -m "feat(frontend): add GithubAuth page with device flow UX"
```

---

## Task 11: Wire the page into routing + Overview banner + nav

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/Overview.tsx`

- [ ] **Step 1: Register route in `App.tsx`**

Replace the `Routes` block:

```tsx
import { GithubAuth } from "./pages/GithubAuth"

// …

return (
  <Layout>
    <Routes>
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<Overview />} />
      <Route
        path="/tokens"
        element={
          me.role === "user" ?
            <Navigate to="/overview" replace />
          : <Tokens />
        }
      />
      <Route path="/usage" element={<Usage />} />
      <Route path="/settings" element={<Settings />} />
      <Route
        path="/github-auth"
        element={
          me.role === "super" ?
            <GithubAuth />
          : <Navigate to="/overview" replace />
        }
      />
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  </Layout>
)
```

- [ ] **Step 2: Add Overview banner**

In `frontend/src/pages/Overview.tsx`, at the top of the component, fetch the GitHub status and render a banner. Add this near the existing data-loading hooks (paste exactly):

```tsx
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { api } from "../api/client"
import { useAuth } from "../contexts/AuthContext"
import type { GithubAuthStatus } from "../types"

// Inside the Overview component body, before the existing return:
const { me } = useAuth()
const [gh, setGh] = useState<GithubAuthStatus | null>(null)
useEffect(() => {
  api.githubStatus().then(setGh).catch(() => setGh(null))
}, [])

const banner =
  gh && !gh.copilotReady ? (
    <div className="banner banner--warn">
      GitHub not connected — Copilot endpoints disabled.{" "}
      {me?.role === "super" ? (
        <Link to="/github-auth">Sign in</Link>
      ) : (
        <span>Contact a super admin.</span>
      )}
    </div>
  ) : null
```

Then render `{banner}` at the top of the existing return JSX.

If `useAuth` is not already imported in Overview, add the import. If the `Overview` file doesn't already import `useEffect/useState` from React, add them.

- [ ] **Step 3: Add nav entry (only if Layout has a sidebar)**

Open `frontend/src/components/Layout.tsx`. If it renders a nav list, add a conditional entry for `me?.role === "super"` linking to `/github-auth` with label "GitHub Auth". If the file structure differs, skip this step — the page is still reachable via the Overview banner.

- [ ] **Step 4: Build the frontend**

Run from repo root: `bun run build`
Expected: builds successfully.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/Overview.tsx frontend/src/components/Layout.tsx
git commit -m "feat(frontend): expose GitHub auth page via route, banner, and nav"
```

---

## Task 12: Final integration + smoke test

- [ ] **Step 1: Run everything**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: all green.

- [ ] **Step 2: Manual smoke test**

```bash
mv ~/.local/share/copilot-api/github-token /tmp/gh-token-backup 2>/dev/null || true
bun run start --port 4141 &
sleep 3
# health
curl -fsS http://localhost:4141/healthz
# Copilot route should be 503 now
curl -i -X POST http://localhost:4141/chat/completions \
  -H "authorization: Bearer $(cat ~/.local/share/copilot-api/auth-token)" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4","messages":[]}' | head -1
# expect: HTTP/1.1 503
kill %1
mv /tmp/gh-token-backup ~/.local/share/copilot-api/github-token 2>/dev/null || true
```

Expected: health is `ok`, chat-completions returns `503`. Open `http://localhost:4141/github-auth` in a browser, log in with super-admin token, click "Sign in to GitHub", verify the device code flow.

- [ ] **Step 3: Final commit if any cleanup is needed**

```bash
git status
# commit any forgotten lint/format fixups
```

---

## Self-Review Notes

- **Spec coverage:** all 6 spec sections covered — startup behavior (Tasks 2/3), device flow manager (Task 7), admin API (Task 8), security & boundaries (Tasks 5/8), frontend (Tasks 9–11), tests (Tasks 4/7/8).
- **Symbol consistency:** `bootstrapCopilotToken`, `stopCopilotTokenRefresh`, `clearGithubToken`, `startDeviceFlow`, `getFlow`, `cancelFlow`, `getActiveFlow`, `__resetDeviceFlowsForTest`, `requireCopilotReady` are used consistently across tasks.
- **Test gating:** `requireCopilotReady` middleware is added in Task 5; existing Copilot route tests may need `state.copilotToken = "x"` in their setup — Task 5 step 3 catches this.
- **No placeholders:** every code-changing step contains the exact code or commands.
