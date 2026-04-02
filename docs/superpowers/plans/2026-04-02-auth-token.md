# Auth Token Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API key verification middleware so only clients with a valid auth token can access the copilot-api proxy.

**Architecture:** A Hono middleware intercepts all requests (except health check `/`) and validates the client's token against a pre-shared key stored on disk. Token is auto-generated on first server start and persisted to `~/.local/share/copilot-api/auth_token`. Auth is on by default, toggled off with `--no-auth`.

**Tech Stack:** Hono middleware, Node.js `crypto` module, Bun test runner, Citty CLI

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/auth-token.ts` | Create | Token generate / load / save utilities |
| `src/lib/auth-middleware.ts` | Create | Hono middleware for token verification |
| `src/scripts/generate-token.ts` | Create | Standalone npm script to generate token |
| `src/auth-token.ts` | Create | CLI subcommand `auth-token` |
| `src/lib/state.ts` | Modify | Add `authToken` and `authEnabled` fields |
| `src/lib/paths.ts` | Modify | Add `AUTH_TOKEN_PATH` constant |
| `src/server.ts` | Modify | Mount auth middleware |
| `src/start.ts` | Modify | Add `--no-auth` arg, call `setupAuthToken` |
| `src/main.ts` | Modify | Register `auth-token` subcommand |
| `package.json` | Modify | Add `generate-token` script |
| `tests/auth-token.test.ts` | Create | Unit tests for token utilities |
| `tests/auth-middleware.test.ts` | Create | Unit tests for auth middleware |

---

### Task 1: Token Utility — `src/lib/auth-token.ts`

**Files:**
- Modify: `src/lib/paths.ts:7-14`
- Modify: `src/lib/state.ts:1-25`
- Create: `src/lib/auth-token.ts`
- Test: `tests/auth-token.test.ts`

- [ ] **Step 1: Add `AUTH_TOKEN_PATH` to paths.ts**

In `src/lib/paths.ts`, add the new path constant after `CONFIG_PATH` (line 8):

```typescript
const AUTH_TOKEN_PATH = path.join(APP_DIR, "auth_token")
```

And add it to the `PATHS` export (inside the object, after `CONFIG_PATH`):

```typescript
export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_PATH,
  AUTH_TOKEN_PATH,
}
```

- [ ] **Step 2: Add auth fields to State interface**

In `src/lib/state.ts`, add two new fields to the `State` interface (after the `lastRequestTimestamp` field, line 17):

```typescript
  // Auth token configuration
  authToken?: string
  authEnabled: boolean
```

And add the default value in the `state` object (after `showToken: false`, line 24):

```typescript
export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  authEnabled: true,
}
```

- [ ] **Step 3: Write failing tests for auth-token utilities**

Create `tests/auth-token.test.ts`:

```typescript
import { describe, test, expect } from "bun:test"

import {
  generateAuthToken,
  loadAuthToken,
  saveAuthToken,
} from "../src/lib/auth-token"
import { PATHS } from "../src/lib/paths"
import fs from "node:fs/promises"

describe("generateAuthToken", () => {
  test("should return a string starting with cpk-", () => {
    const token = generateAuthToken()
    expect(token.startsWith("cpk-")).toBe(true)
  })

  test("should return a 68-character token (cpk- + 64 hex chars)", () => {
    const token = generateAuthToken()
    expect(token).toHaveLength(68)
  })

  test("should generate unique tokens each time", () => {
    const token1 = generateAuthToken()
    const token2 = generateAuthToken()
    expect(token1).not.toBe(token2)
  })

  test("should only contain hex characters after prefix", () => {
    const token = generateAuthToken()
    const hex = token.slice(4)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("saveAuthToken and loadAuthToken", () => {
  test("should save and load token from disk", async () => {
    const token = generateAuthToken()
    await saveAuthToken(token)

    const loaded = await loadAuthToken()
    expect(loaded).toBe(token)

    // Cleanup
    await fs.writeFile(PATHS.AUTH_TOKEN_PATH, "")
  })

  test("should return undefined when token file is empty", async () => {
    await fs.writeFile(PATHS.AUTH_TOKEN_PATH, "")
    const loaded = await loadAuthToken()
    expect(loaded).toBeUndefined()
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test tests/auth-token.test.ts`
Expected: FAIL — `generateAuthToken`, `loadAuthToken`, `saveAuthToken` not found

- [ ] **Step 5: Implement auth-token utilities**

Create `src/lib/auth-token.ts`:

```typescript
import crypto from "node:crypto"
import fs from "node:fs/promises"

import consola from "consola"

import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

export function generateAuthToken(): string {
  const bytes = crypto.randomBytes(32)
  return `cpk-${bytes.toString("hex")}`
}

export async function loadAuthToken(): Promise<string | undefined> {
  try {
    const token = await fs.readFile(PATHS.AUTH_TOKEN_PATH, "utf8")
    const trimmed = token.trim()
    return trimmed || undefined
  } catch {
    return undefined
  }
}

export async function saveAuthToken(token: string): Promise<void> {
  await fs.writeFile(PATHS.AUTH_TOKEN_PATH, token)
  await fs.chmod(PATHS.AUTH_TOKEN_PATH, 0o600)
}

export async function setupAuthToken(): Promise<void> {
  if (!state.authEnabled) {
    consola.info("Auth: disabled")
    return
  }

  let token = await loadAuthToken()

  if (!token) {
    token = generateAuthToken()
    await saveAuthToken(token)
    consola.info(`Auth token generated: ${token}`)
  }

  state.authToken = token
  consola.info("Auth: enabled (use --no-auth to disable)")
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/auth-token.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth-token.ts src/lib/paths.ts src/lib/state.ts tests/auth-token.test.ts
git commit -m "feat: add auth token generation, loading, and saving utilities"
```

---

### Task 2: Auth Middleware — `src/lib/auth-middleware.ts`

**Files:**
- Create: `src/lib/auth-middleware.ts`
- Test: `tests/auth-middleware.test.ts`

- [ ] **Step 1: Write failing tests for auth middleware**

Create `tests/auth-middleware.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test"
import { Hono } from "hono"

import { authMiddleware } from "../src/lib/auth-middleware"
import { state } from "../src/lib/state"

function createTestApp(): Hono {
  const app = new Hono()
  app.use(authMiddleware())
  app.get("/", (c) => c.text("health"))
  app.post("/v1/chat/completions", (c) => c.text("ok"))
  app.post("/v1/messages", (c) => c.text("ok"))
  return app
}

describe("authMiddleware", () => {
  beforeEach(() => {
    state.authEnabled = true
    state.authToken = "cpk-testtoken1234567890abcdef1234567890abcdef1234567890abcdef12345678"
  })

  test("should allow requests with valid Bearer token", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${state.authToken}` },
    })
    expect(res.status).toBe(200)
  })

  test("should allow requests with valid x-api-key", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": state.authToken! },
    })
    expect(res.status).toBe(200)
  })

  test("should prefer Authorization header over x-api-key", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.authToken}`,
        "x-api-key": "wrong-token",
      },
    })
    expect(res.status).toBe(200)
  })

  test("should return 401 when no auth headers provided", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.type).toBe("auth_error")
  })

  test("should return 401 when token is invalid", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.type).toBe("auth_error")
  })

  test("should skip auth for root health check path", async () => {
    const app = createTestApp()
    const res = await app.request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("health")
  })

  test("should skip auth when authEnabled is false", async () => {
    state.authEnabled = false
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
    })
    expect(res.status).toBe(200)
  })

  test("should return 401 when Authorization header has no Bearer prefix", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: state.authToken! },
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/auth-middleware.test.ts`
Expected: FAIL — `authMiddleware` not found

- [ ] **Step 3: Implement auth middleware**

Create `src/lib/auth-middleware.ts`:

```typescript
import type { MiddlewareHandler } from "hono"

import crypto from "node:crypto"

import { state } from "~/lib/state"

function extractToken(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const authHeader = c.req.header("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7)
  }

  return c.req.header("x-api-key")
}

function constantTimeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!state.authEnabled || !state.authToken) {
      return next()
    }

    if (c.req.path === "/") {
      return next()
    }

    const token = extractToken(c)

    if (!token) {
      return c.json(
        {
          error: {
            message:
              "Missing auth token. Set Authorization header or x-api-key header.",
            type: "auth_error",
          },
        },
        401,
      )
    }

    if (!constantTimeEqual(token, state.authToken)) {
      return c.json(
        {
          error: {
            message: "Invalid auth token.",
            type: "auth_error",
          },
        },
        401,
      )
    }

    return next()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/auth-middleware.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth-middleware.ts tests/auth-middleware.test.ts
git commit -m "feat: add auth token verification middleware"
```

---

### Task 3: Server Integration — Mount Middleware

**Files:**
- Modify: `src/server.ts:1-16`

- [ ] **Step 1: Add auth middleware to server.ts**

In `src/server.ts`, add the import (after the `logger` import, line 3):

```typescript
import { authMiddleware } from "./lib/auth-middleware"
```

Add the middleware call after `server.use(cors())` (after line 15):

```typescript
server.use(logger())
server.use(cors())
server.use(authMiddleware())
```

The full file should look like:

```typescript
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { authMiddleware } from "./lib/auth-middleware"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(logger())
server.use(cors())
server.use(authMiddleware())

server.get("/", (c) => c.text("Server running"))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `bun test`
Expected: All existing tests PASS (auth is enabled by default but `state.authToken` is undefined during tests, so middleware skips — the `!state.authToken` guard handles this)

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: mount auth middleware in server pipeline"
```

---

### Task 4: CLI Integration — `--no-auth` Flag and `auth-token` Subcommand

**Files:**
- Modify: `src/start.ts:18-230`
- Create: `src/auth-token.ts`
- Modify: `src/main.ts:1-19`
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Add `--no-auth` arg and `setupAuthToken` call to start.ts**

In `src/start.ts`, add the import for `setupAuthToken` (after the `state` import, line 13):

```typescript
import { setupAuthToken } from "./lib/auth-token"
```

Add `noAuth` to the `RunServerOptions` interface (after `showToken`, line 28):

```typescript
interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  noAuth: boolean
  proxyEnv: boolean
  tlsCert?: string
  tlsKey?: string
}
```

In the `runServer` function, add `state.authEnabled` assignment after the `state.showToken` line (after line 51):

```typescript
  state.showToken = options.showToken
  state.authEnabled = !options.noAuth
```

Add `setupAuthToken()` call after `await cacheModels()` (after line 64):

```typescript
  await cacheModels()
  await setupAuthToken()
```

In the `--claude-code` block, replace `ANTHROPIC_AUTH_TOKEN: "dummy"` (line 103) with:

```typescript
        ANTHROPIC_AUTH_TOKEN: state.authToken ?? "dummy",
```

Add the `--no-auth` arg definition in the `args` object (after `show-token` arg definition, after line 194):

```typescript
    "no-auth": {
      type: "boolean",
      default: false,
      description: "Disable auth token verification",
    },
```

Add `noAuth` to the `runServer` call in the `run` method (after `showToken`, line 222):

```typescript
      showToken: args["show-token"],
      noAuth: args["no-auth"],
```

- [ ] **Step 2: Create `auth-token` CLI subcommand**

Create `src/auth-token.ts`:

```typescript
#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import {
  generateAuthToken,
  loadAuthToken,
  saveAuthToken,
} from "./lib/auth-token"
import { ensurePaths } from "./lib/paths"

interface RunAuthTokenOptions {
  regenerate: boolean
}

export async function runAuthToken(
  options: RunAuthTokenOptions,
): Promise<void> {
  await ensurePaths()

  if (!options.regenerate) {
    const existing = await loadAuthToken()
    if (existing) {
      consola.info(`Auth token: ${existing}`)
      return
    }
  }

  const token = generateAuthToken()
  await saveAuthToken(token)
  consola.success(`Auth token generated: ${token}`)
}

export const authToken = defineCommand({
  meta: {
    name: "auth-token",
    description: "View or generate the API auth token",
  },
  args: {
    regenerate: {
      type: "boolean",
      default: false,
      description: "Force regenerate the auth token",
    },
  },
  run({ args }) {
    return runAuthToken({
      regenerate: args.regenerate,
    })
  },
})
```

- [ ] **Step 3: Register subcommand in main.ts**

In `src/main.ts`, add the import (after line 5):

```typescript
import { authToken } from "./auth-token"
```

Add `"auth-token": authToken` to the `subCommands` object (line 16):

```typescript
  subCommands: {
    auth,
    start,
    "check-usage": checkUsage,
    "auth-token": authToken,
    debug,
  },
```

- [ ] **Step 4: Add `generate-token` npm script to package.json**

In `package.json`, add to the `scripts` object (after the `dev` script, line 28):

```json
    "generate-token": "bun run ./src/scripts/generate-token.ts",
```

- [ ] **Step 5: Create standalone generate-token script**

Create `src/scripts/generate-token.ts`:

```typescript
#!/usr/bin/env node

import consola from "consola"

import { generateAuthToken, saveAuthToken } from "../lib/auth-token"
import { ensurePaths } from "../lib/paths"

async function main(): Promise<void> {
  await ensurePaths()

  const token = generateAuthToken()
  await saveAuthToken(token)

  consola.success(`Auth token generated: ${token}`)
}

await main()
```

- [ ] **Step 6: Run all tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: All tests PASS, no type errors

- [ ] **Step 7: Run lint**

Run: `bun run lint:all`
Expected: No lint errors (or only pre-existing ones)

- [ ] **Step 8: Commit**

```bash
git add src/start.ts src/auth-token.ts src/main.ts src/scripts/generate-token.ts package.json
git commit -m "feat: add --no-auth CLI flag, auth-token subcommand, and generate-token script"
```

---

### Task 5: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 3: Run lint**

Run: `bun run lint:all`
Expected: Clean or only pre-existing warnings

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 5: Manual smoke test — generate token**

Run: `bun run generate-token`
Expected: Outputs `Auth token generated: cpk-<64 hex chars>`

- [ ] **Step 6: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: address lint/type issues from auth token feature"
```
