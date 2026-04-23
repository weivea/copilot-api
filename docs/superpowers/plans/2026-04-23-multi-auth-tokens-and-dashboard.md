# Multi Auth-Token Management & Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-token outbound auth with a multi-token system: one file-resident super admin + many SQLite-backed tokens with per-token usage metering, limits, and a React admin dashboard at `/?key=<token>`. Upstream Copilot auth is unchanged.

**Architecture:** Add a SQLite layer (drizzle-orm + bun:sqlite) for tokens, request logs, sessions, and reset events. Upgrade `authMiddleware` to consult both file token (super admin) and DB; add a `usageRecorder` middleware that writes one log per business request and updates the lifetime counter. Add `/admin/api/*` routes behind a session-cookie middleware. Build a small React + Vite SPA (mounted statically) for login + Overview + Tokens + Usage + Settings.

**Tech Stack:** Bun, Hono, Citty, TypeScript (strict), drizzle-orm + drizzle-kit, bun:sqlite, React 18, react-router-dom, recharts, Vite.

**Spec:** `docs/superpowers/specs/2026-04-23-multi-auth-tokens-and-dashboard-design.md`

---

## File Structure (created/modified across the plan)

**New backend modules**
- `src/db/client.ts` — opens `bun:sqlite`, exports drizzle instance, runs migrations on startup
- `src/db/schema.ts` — drizzle table definitions (`auth_tokens`, `request_logs`, `sessions`, `usage_resets`)
- `src/db/queries/auth-tokens.ts` — CRUD helpers for `auth_tokens`
- `src/db/queries/request-logs.ts` — insert + RPM/monthly aggregations + retention prune
- `src/db/queries/sessions.ts` — create/get/delete/expire-sweep
- `src/db/queries/usage-resets.ts` — append + lookup latest
- `src/lib/auth-token-utils.ts` — generate/format/hash/prefix helpers (reused by file token + DB)
- `src/lib/usage-recorder.ts` — Hono middleware + helpers to count tokens & write logs
- `src/lib/session.ts` — cookie helpers + sessionMiddleware factory
- `src/routes/admin/route.ts` — mounts the admin subapp
- `src/routes/admin/auth.ts` — `POST /login`, `POST /logout`, `GET /me`
- `src/routes/admin/tokens.ts` — token CRUD + reset endpoints
- `src/routes/admin/usage.ts` — summary / timeseries / per-token / recent
- `src/lib/static-spa.ts` — Hono static handler for `dist/public` with SPA fallback
- `src/lib/redacting-logger.ts` — wraps `hono/logger` to strip `?key=` from URLs
- `drizzle.config.ts` — drizzle-kit config (root)

**Modified backend modules**
- `src/lib/state.ts` — drop `authToken`/`authEnabled` (move to dedicated config), add `dashboardEnabled`, `logRetentionDays`, `dbPath`, `superAdminToken`, `superAdminTokenHash`
- `src/lib/auth-token.ts` — keep file-token lifecycle, expose hash + prefix
- `src/lib/auth-middleware.ts` — rewrite to support file token + DB tokens + limit enforcement
- `src/lib/paths.ts` — add `DB_PATH`
- `src/server.ts` — mount admin routes, static SPA, swap logger
- `src/start.ts` — new CLI flags + DB init + session cleanup timer
- `package.json` — add deps, build:frontend script
- `.gitignore` — add `dist/public`, `frontend/node_modules`

**New frontend project (`frontend/`)**
- `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`, `frontend/index.html`
- `frontend/src/main.tsx`, `frontend/src/App.tsx`
- `frontend/src/api/client.ts`
- `frontend/src/contexts/AuthContext.tsx`
- `frontend/src/pages/Login.tsx`, `Overview.tsx`, `Tokens.tsx`, `Usage.tsx`, `Settings.tsx`
- `frontend/src/components/Layout.tsx`, `TimeRangePicker.tsx`, `TrendChart.tsx`, `PerTokenTable.tsx`, `TokenFormDialog.tsx`, `ConfirmDialog.tsx`
- `frontend/src/types.ts`
- `frontend/src/styles.css`
- `frontend/src/lib/bucket.ts` (pure helper, unit tested)
- `frontend/src/lib/bucket.test.ts`

**Tests (new)**
- `tests/db-schema.test.ts`
- `tests/auth-token-utils.test.ts`
- `tests/queries-auth-tokens.test.ts`
- `tests/queries-request-logs.test.ts`
- `tests/queries-sessions.test.ts`
- `tests/auth-middleware-multi.test.ts` (replaces parts of existing `tests/auth-middleware.test.ts`)
- `tests/usage-recorder.test.ts`
- `tests/admin-auth.test.ts`
- `tests/admin-tokens.test.ts`
- `tests/admin-usage.test.ts`
- `tests/redacting-logger.test.ts`

---

## Phase Map

- **Phase 1** — Foundations: dependencies, DB schema, query helpers (TDD)
- **Phase 2** — Auth & usage middleware overhaul (TDD)
- **Phase 3** — Admin API: sessions, tokens, usage (TDD)
- **Phase 4** — Server wiring, CLI flags, static SPA fallback, redacting logger
- **Phase 5** — Frontend: Vite project, Login + Layout
- **Phase 6** — Frontend: Tokens page (admin)
- **Phase 7** — Frontend: Usage page + Overview + Settings
- **Phase 8** — Build integration & end-to-end smoke

Each task ends with a commit. Phases 1–4 leave the backend fully working; Phases 5–8 add the SPA.

---

## Phase 1 — Foundations: deps, DB schema, query helpers

### Task 1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add runtime + dev deps**

In `package.json` `dependencies`, add:
```
"drizzle-orm": "^0.36.0",
```
In `devDependencies`, add:
```
"drizzle-kit": "^0.28.0",
```
- [ ] **Step 2: Install**

Run: `bun install`
Expected: lockfile updates, no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add drizzle-orm and drizzle-kit"
```

---

### Task 2: Define drizzle schema

**Files:**
- Create: `src/db/schema.ts`

- [ ] **Step 1: Write the schema**

```ts
import { sql } from "drizzle-orm"
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    isAdmin: integer("is_admin").notNull().default(0),
    isDisabled: integer("is_disabled").notNull().default(0),
    rpmLimit: integer("rpm_limit"),
    monthlyTokenLimit: integer("monthly_token_limit"),
    lifetimeTokenLimit: integer("lifetime_token_limit"),
    lifetimeTokenUsed: integer("lifetime_token_used").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    createdBy: integer("created_by"),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => ({
    tokenHashUq: uniqueIndex("auth_tokens_token_hash_uq").on(t.tokenHash),
    isDisabledIdx: index("auth_tokens_is_disabled_idx").on(t.isDisabled),
  }),
)

export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authTokenId: integer("auth_token_id"),
    timestamp: integer("timestamp").notNull(),
    endpoint: text("endpoint").notNull(),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    statusCode: integer("status_code").notNull(),
    latencyMs: integer("latency_ms"),
  },
  (t) => ({
    tokenTsIdx: index("request_logs_token_ts_idx").on(
      t.authTokenId,
      t.timestamp,
    ),
    tsIdx: index("request_logs_ts_idx").on(t.timestamp),
  }),
)

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    authTokenId: integer("auth_token_id"),
    isSuperAdmin: integer("is_super_admin").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
)

export const usageResets = sqliteTable(
  "usage_resets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authTokenId: integer("auth_token_id").notNull(),
    kind: text("kind", { enum: ["monthly", "lifetime"] }).notNull(),
    resetAt: integer("reset_at").notNull(),
  },
  (t) => ({
    tokKindIdx: index("usage_resets_token_kind_idx").on(
      t.authTokenId,
      t.kind,
      t.resetAt,
    ),
  }),
)

// Avoid unused-import lint when sql template not referenced elsewhere
export const _sqlTag = sql
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(db): add drizzle schema for tokens, logs, sessions, resets"
```

---

### Task 3: drizzle-kit config + initial migration

**Files:**
- Create: `drizzle.config.ts`
- Create: `drizzle/` (generated)
- Modify: `package.json`

- [ ] **Step 1: Write drizzle.config.ts**

```ts
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
})
```

- [ ] **Step 2: Add db:generate script**

In `package.json` `scripts`, add:
```
"db:generate": "drizzle-kit generate"
```

- [ ] **Step 3: Generate migration**

Run: `bun run db:generate`
Expected: a new file `drizzle/0000_*.sql` plus `drizzle/meta/_journal.json` etc.

- [ ] **Step 4: Commit**

```bash
git add drizzle.config.ts package.json drizzle/
git commit -m "feat(db): add drizzle-kit config and initial migration"
```

---

### Task 4: DB client with migrations

**Files:**
- Create: `src/db/client.ts`
- Modify: `src/lib/paths.ts`

- [ ] **Step 1: Add DB_PATH to paths.ts**

Open `src/lib/paths.ts`. Add `DB_PATH` to the path constants:

```ts
const DB_PATH = path.join(APP_DIR, "copilot-api.db")
```

And include it in the exported `PATHS` object:
```ts
export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_PATH,
  AUTH_TOKEN_PATH,
  DB_PATH,
}
```

- [ ] **Step 2: Write client.ts**

```ts
import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import fs from "node:fs"
import path from "node:path"

import * as schema from "./schema"

let db: BunSQLiteDatabase<typeof schema> | undefined

export function initDb(dbPath: string): BunSQLiteDatabase<typeof schema> {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.exec("PRAGMA journal_mode = WAL;")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  try {
    fs.chmodSync(dbPath, 0o600)
  } catch {
    /* ignore on systems that don't support chmod */
  }
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: "drizzle" })
  return db
}

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (!db) throw new Error("DB not initialized; call initDb first")
  return db
}

// Test helper: replace the active DB (e.g. in-memory) without re-running migrations
export function _setDbForTest(
  next: BunSQLiteDatabase<typeof schema>,
): void {
  db = next
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/client.ts src/lib/paths.ts
git commit -m "feat(db): add bun:sqlite client with migrations"
```

---

### Task 5: Test-DB helper for unit tests

**Files:**
- Create: `tests/helpers/test-db.ts`

- [ ] **Step 1: Write helper**

```ts
import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

import * as schema from "../../src/db/schema"
import { _setDbForTest } from "../../src/db/client"

export function makeTestDb(): BunSQLiteDatabase<typeof schema> {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: "drizzle" })
  _setDbForTest(db)
  return db
}
```

- [ ] **Step 2: Sanity test**

Create `tests/db-schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { authTokens } from "../src/db/schema"
import { makeTestDb } from "./helpers/test-db"

describe("db schema", () => {
  test("can insert and select a token row", () => {
    const db = makeTestDb()
    db.insert(authTokens)
      .values({
        name: "alice",
        tokenHash: "h",
        tokenPrefix: "cpk-aaaa...bbbb",
        createdAt: Date.now(),
      })
      .run()
    const rows = db.select().from(authTokens).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe("alice")
    expect(rows[0]?.isAdmin).toBe(0)
    expect(rows[0]?.lifetimeTokenUsed).toBe(0)
  })
})
```

- [ ] **Step 3: Run**

Run: `bun test tests/db-schema.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/test-db.ts tests/db-schema.test.ts
git commit -m "test(db): in-memory test DB helper + schema sanity test"
```

---

### Task 6: Auth token utility helpers (TDD)

**Files:**
- Create: `tests/auth-token-utils.test.ts`
- Create: `src/lib/auth-token-utils.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"

import {
  generateToken,
  hashToken,
  prefixOf,
} from "../src/lib/auth-token-utils"

describe("auth-token-utils", () => {
  test("generateToken returns cpk-<64 hex>", () => {
    const t = generateToken()
    expect(t).toMatch(/^cpk-[0-9a-f]{64}$/)
  })

  test("hashToken returns deterministic 64-char hex", () => {
    const a = hashToken("cpk-abc")
    const b = hashToken("cpk-abc")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test("hashToken differs for different inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"))
  })

  test("prefixOf returns first 8 + ... + last 4 of suffix", () => {
    // cpk- + 64 hex = 68 chars
    const tok = "cpk-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"
    expect(prefixOf(tok)).toBe("cpk-0123...abcd")
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/auth-token-utils.test.ts`
Expected: FAIL ("Cannot find module ... auth-token-utils").

- [ ] **Step 3: Implement**

```ts
import crypto from "node:crypto"

export function generateToken(): string {
  return `cpk-${crypto.randomBytes(32).toString("hex")}`
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

export function prefixOf(token: string): string {
  // Display form: first 8 chars (incl. "cpk-") ... last 4 chars
  if (token.length <= 12) return token
  return `${token.slice(0, 8)}...${token.slice(-4)}`
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `bun test tests/auth-token-utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth-token-utils.ts tests/auth-token-utils.test.ts
git commit -m "feat(auth): token generate/hash/prefix utilities"
```

---

### Task 7: `auth_tokens` queries (TDD)

**Files:**
- Create: `tests/queries-auth-tokens.test.ts`
- Create: `src/db/queries/auth-tokens.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { beforeEach, describe, expect, test } from "bun:test"

import {
  createAuthToken,
  deleteAuthToken,
  findAuthTokenByHash,
  getAuthTokenById,
  listAuthTokens,
  setLifetimeUsed,
  touchLastUsed,
  updateAuthToken,
} from "../src/db/queries/auth-tokens"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
})

describe("auth-tokens queries", () => {
  test("create + find by hash + getById", async () => {
    const id = await createAuthToken({
      name: "alice",
      tokenHash: "h1",
      tokenPrefix: "cpk-aaaa...bbbb",
    })
    expect(id).toBeGreaterThan(0)
    const byHash = await findAuthTokenByHash("h1")
    expect(byHash?.name).toBe("alice")
    const byId = await getAuthTokenById(id)
    expect(byId?.id).toBe(id)
  })

  test("create with all fields", async () => {
    const id = await createAuthToken({
      name: "bob",
      tokenHash: "h2",
      tokenPrefix: "cpk-cccc...dddd",
      isAdmin: true,
      rpmLimit: 60,
      monthlyTokenLimit: 1000,
      lifetimeTokenLimit: 10_000,
      createdBy: 7,
    })
    const row = await getAuthTokenById(id)
    expect(row?.isAdmin).toBe(1)
    expect(row?.rpmLimit).toBe(60)
    expect(row?.createdBy).toBe(7)
  })

  test("list returns all", async () => {
    await createAuthToken({ name: "a", tokenHash: "ha", tokenPrefix: "p" })
    await createAuthToken({ name: "b", tokenHash: "hb", tokenPrefix: "p" })
    const rows = await listAuthTokens()
    expect(rows).toHaveLength(2)
  })

  test("update modifies given fields only", async () => {
    const id = await createAuthToken({
      name: "alice",
      tokenHash: "h",
      tokenPrefix: "p",
      monthlyTokenLimit: 100,
    })
    await updateAuthToken(id, { name: "alice2", rpmLimit: 30 })
    const row = await getAuthTokenById(id)
    expect(row?.name).toBe("alice2")
    expect(row?.rpmLimit).toBe(30)
    expect(row?.monthlyTokenLimit).toBe(100)
  })

  test("delete removes row", async () => {
    const id = await createAuthToken({
      name: "x",
      tokenHash: "hx",
      tokenPrefix: "p",
    })
    await deleteAuthToken(id)
    expect(await getAuthTokenById(id)).toBeUndefined()
  })

  test("setLifetimeUsed and touchLastUsed", async () => {
    const id = await createAuthToken({
      name: "x",
      tokenHash: "hx",
      tokenPrefix: "p",
    })
    await setLifetimeUsed(id, 42)
    await touchLastUsed(id, 1234)
    const row = await getAuthTokenById(id)
    expect(row?.lifetimeTokenUsed).toBe(42)
    expect(row?.lastUsedAt).toBe(1234)
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/queries-auth-tokens.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { eq } from "drizzle-orm"

import { getDb } from "../client"
import { authTokens } from "../schema"

export interface NewAuthToken {
  name: string
  tokenHash: string
  tokenPrefix: string
  isAdmin?: boolean
  rpmLimit?: number | null
  monthlyTokenLimit?: number | null
  lifetimeTokenLimit?: number | null
  createdBy?: number | null
}

export interface AuthTokenRow {
  id: number
  name: string
  tokenHash: string
  tokenPrefix: string
  isAdmin: number
  isDisabled: number
  rpmLimit: number | null
  monthlyTokenLimit: number | null
  lifetimeTokenLimit: number | null
  lifetimeTokenUsed: number
  createdAt: number
  createdBy: number | null
  lastUsedAt: number | null
}

export async function createAuthToken(
  input: NewAuthToken,
): Promise<number> {
  const db = getDb()
  const [row] = await db
    .insert(authTokens)
    .values({
      name: input.name,
      tokenHash: input.tokenHash,
      tokenPrefix: input.tokenPrefix,
      isAdmin: input.isAdmin ? 1 : 0,
      rpmLimit: input.rpmLimit ?? null,
      monthlyTokenLimit: input.monthlyTokenLimit ?? null,
      lifetimeTokenLimit: input.lifetimeTokenLimit ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: Date.now(),
    })
    .returning({ id: authTokens.id })
  if (!row) throw new Error("insert failed")
  return row.id
}

export async function findAuthTokenByHash(
  hash: string,
): Promise<AuthTokenRow | undefined> {
  const db = getDb()
  const rows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.tokenHash, hash))
    .limit(1)
  return rows[0] as AuthTokenRow | undefined
}

export async function getAuthTokenById(
  id: number,
): Promise<AuthTokenRow | undefined> {
  const db = getDb()
  const rows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.id, id))
    .limit(1)
  return rows[0] as AuthTokenRow | undefined
}

export async function listAuthTokens(): Promise<Array<AuthTokenRow>> {
  const db = getDb()
  return (await db.select().from(authTokens)) as Array<AuthTokenRow>
}

export interface UpdateAuthToken {
  name?: string
  isAdmin?: boolean
  isDisabled?: boolean
  rpmLimit?: number | null
  monthlyTokenLimit?: number | null
  lifetimeTokenLimit?: number | null
}

export async function updateAuthToken(
  id: number,
  patch: UpdateAuthToken,
): Promise<void> {
  const db = getDb()
  const values: Record<string, unknown> = {}
  if (patch.name !== undefined) values.name = patch.name
  if (patch.isAdmin !== undefined) values.isAdmin = patch.isAdmin ? 1 : 0
  if (patch.isDisabled !== undefined)
    values.isDisabled = patch.isDisabled ? 1 : 0
  if (patch.rpmLimit !== undefined) values.rpmLimit = patch.rpmLimit
  if (patch.monthlyTokenLimit !== undefined)
    values.monthlyTokenLimit = patch.monthlyTokenLimit
  if (patch.lifetimeTokenLimit !== undefined)
    values.lifetimeTokenLimit = patch.lifetimeTokenLimit
  if (Object.keys(values).length === 0) return
  await db.update(authTokens).set(values).where(eq(authTokens.id, id))
}

export async function deleteAuthToken(id: number): Promise<void> {
  const db = getDb()
  await db.delete(authTokens).where(eq(authTokens.id, id))
}

export async function setLifetimeUsed(
  id: number,
  value: number,
): Promise<void> {
  const db = getDb()
  await db
    .update(authTokens)
    .set({ lifetimeTokenUsed: value })
    .where(eq(authTokens.id, id))
}

export async function incrementLifetimeUsed(
  id: number,
  delta: number,
): Promise<void> {
  if (delta <= 0) return
  const db = getDb()
  const sql = `UPDATE auth_tokens SET lifetime_token_used = lifetime_token_used + ? WHERE id = ?`
  // Drizzle exposes underlying sqlite for raw exec
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(db as any).$client.prepare(sql).run(delta, id)
}

export async function touchLastUsed(
  id: number,
  timestamp: number,
): Promise<void> {
  const db = getDb()
  await db
    .update(authTokens)
    .set({ lastUsedAt: timestamp })
    .where(eq(authTokens.id, id))
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `bun test tests/queries-auth-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/auth-tokens.ts tests/queries-auth-tokens.test.ts
git commit -m "feat(db): auth-tokens query helpers with tests"
```

---

### Task 8: `request_logs` + `usage_resets` queries (TDD)

**Files:**
- Create: `tests/queries-request-logs.test.ts`
- Create: `src/db/queries/request-logs.ts`
- Create: `src/db/queries/usage-resets.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { beforeEach, describe, expect, test } from "bun:test"

import { createAuthToken } from "../src/db/queries/auth-tokens"
import {
  countRequestsSince,
  insertRequestLog,
  pruneOldLogs,
  recentLogs,
  sumTokensSince,
  timeseriesByBucket,
} from "../src/db/queries/request-logs"
import {
  appendUsageReset,
  latestUsageReset,
} from "../src/db/queries/usage-resets"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
})

async function makeToken(): Promise<number> {
  return createAuthToken({ name: "x", tokenHash: "h", tokenPrefix: "p" })
}

describe("request-logs queries", () => {
  test("insert + countRequestsSince", async () => {
    const id = await makeToken()
    const now = Date.now()
    await insertRequestLog({
      authTokenId: id,
      timestamp: now - 1000,
      endpoint: "/v1/messages",
      statusCode: 200,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
    expect(await countRequestsSince(id, now - 5000)).toBe(1)
    expect(await countRequestsSince(id, now)).toBe(0)
  })

  test("sumTokensSince ignores null totals", async () => {
    const id = await makeToken()
    const now = Date.now()
    await insertRequestLog({
      authTokenId: id,
      timestamp: now - 100,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 50,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: now - 50,
      endpoint: "/x",
      statusCode: 500,
      totalTokens: null,
    })
    expect(await sumTokensSince(id, now - 1000)).toBe(50)
  })

  test("recentLogs respects limit and order desc", async () => {
    const id = await makeToken()
    for (let i = 0; i < 5; i++) {
      await insertRequestLog({
        authTokenId: id,
        timestamp: i,
        endpoint: "/x",
        statusCode: 200,
      })
    }
    const rows = await recentLogs({ tokenId: id, limit: 3 })
    expect(rows.map((r) => r.timestamp)).toEqual([4, 3, 2])
  })

  test("timeseriesByBucket groups by day", async () => {
    const id = await makeToken()
    const day = 86_400_000
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 10,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 5,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 10 + 100,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 7,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 11,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 3,
    })
    const rows = await timeseriesByBucket({
      tokenId: id,
      from: 0,
      to: day * 12,
      bucket: "day",
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ requests: 2, tokens: 12 })
    expect(rows[1]).toMatchObject({ requests: 1, tokens: 3 })
  })

  test("pruneOldLogs deletes rows older than cutoff", async () => {
    const id = await makeToken()
    await insertRequestLog({
      authTokenId: id,
      timestamp: 1,
      endpoint: "/x",
      statusCode: 200,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: 1000,
      endpoint: "/x",
      statusCode: 200,
    })
    await pruneOldLogs(500)
    expect(await countRequestsSince(id, 0)).toBe(1)
  })
})

describe("usage-resets queries", () => {
  test("appendUsageReset + latestUsageReset", async () => {
    const id = await makeToken()
    expect(await latestUsageReset(id, "monthly")).toBe(0)
    await appendUsageReset(id, "monthly", 100)
    await appendUsageReset(id, "monthly", 200)
    expect(await latestUsageReset(id, "monthly")).toBe(200)
    expect(await latestUsageReset(id, "lifetime")).toBe(0)
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/queries-request-logs.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `request-logs.ts`**

```ts
import { and, desc, eq, gte, lt, sql } from "drizzle-orm"

import { getDb } from "../client"
import { requestLogs } from "../schema"

export interface NewRequestLog {
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  statusCode: number
  latencyMs?: number | null
}

export async function insertRequestLog(input: NewRequestLog): Promise<void> {
  const db = getDb()
  await db.insert(requestLogs).values({
    authTokenId: input.authTokenId,
    timestamp: input.timestamp,
    endpoint: input.endpoint,
    model: input.model ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs ?? null,
  })
}

export async function countRequestsSince(
  tokenId: number,
  since: number,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(requestLogs)
    .where(
      and(eq(requestLogs.authTokenId, tokenId), gte(requestLogs.timestamp, since)),
    )
  return rows[0]?.c ?? 0
}

export async function sumTokensSince(
  tokenId: number,
  since: number,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ s: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)` })
    .from(requestLogs)
    .where(
      and(eq(requestLogs.authTokenId, tokenId), gte(requestLogs.timestamp, since)),
    )
  return rows[0]?.s ?? 0
}

export interface RecentLog {
  id: number
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  statusCode: number
  latencyMs: number | null
}

export async function recentLogs(opts: {
  tokenId?: number
  limit: number
}): Promise<Array<RecentLog>> {
  const db = getDb()
  const q = db
    .select()
    .from(requestLogs)
    .orderBy(desc(requestLogs.timestamp))
    .limit(opts.limit)
  const filtered =
    opts.tokenId !== undefined
      ? q.where(eq(requestLogs.authTokenId, opts.tokenId))
      : q
  return (await filtered) as Array<RecentLog>
}

export type Bucket = "hour" | "day" | "week" | "month"

const BUCKET_MS: Record<Bucket, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000, // approximate; UI labels months by start ts
}

export interface TimeseriesRow {
  bucketStart: number
  requests: number
  tokens: number
  authTokenId: number | null
}

export async function timeseriesByBucket(opts: {
  tokenId?: number | "all"
  from: number
  to: number
  bucket: Bucket
}): Promise<Array<TimeseriesRow>> {
  const db = getDb()
  const size = BUCKET_MS[opts.bucket]
  const bucketExpr = sql<number>`(${requestLogs.timestamp} / ${size}) * ${size}`
  const conditions = [
    gte(requestLogs.timestamp, opts.from),
    lt(requestLogs.timestamp, opts.to),
  ]
  if (typeof opts.tokenId === "number") {
    conditions.push(eq(requestLogs.authTokenId, opts.tokenId))
  }
  const splitByToken = opts.tokenId === "all"
  const rows = splitByToken
    ? await db
        .select({
          bucketStart: bucketExpr,
          requests: sql<number>`count(*)`,
          tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
          authTokenId: requestLogs.authTokenId,
        })
        .from(requestLogs)
        .where(and(...conditions))
        .groupBy(bucketExpr, requestLogs.authTokenId)
        .orderBy(bucketExpr)
    : await db
        .select({
          bucketStart: bucketExpr,
          requests: sql<number>`count(*)`,
          tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
        })
        .from(requestLogs)
        .where(and(...conditions))
        .groupBy(bucketExpr)
        .orderBy(bucketExpr)
  return rows.map((r) => ({
    bucketStart: Number(r.bucketStart),
    requests: Number(r.requests),
    tokens: Number(r.tokens),
    authTokenId: "authTokenId" in r ? (r.authTokenId as number | null) : null,
  }))
}

export async function pruneOldLogs(cutoff: number): Promise<void> {
  const db = getDb()
  await db.delete(requestLogs).where(lt(requestLogs.timestamp, cutoff))
}

export async function maybePruneOldLogs(retentionMs: number): Promise<void> {
  if (Math.random() > 0.01) return
  await pruneOldLogs(Date.now() - retentionMs)
}
```

- [ ] **Step 4: Implement `usage-resets.ts`**

```ts
import { and, desc, eq } from "drizzle-orm"

import { getDb } from "../client"
import { usageResets } from "../schema"

export type ResetKind = "monthly" | "lifetime"

export async function appendUsageReset(
  authTokenId: number,
  kind: ResetKind,
  resetAt: number,
): Promise<void> {
  const db = getDb()
  await db.insert(usageResets).values({ authTokenId, kind, resetAt })
}

export async function latestUsageReset(
  authTokenId: number,
  kind: ResetKind,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ ts: usageResets.resetAt })
    .from(usageResets)
    .where(
      and(eq(usageResets.authTokenId, authTokenId), eq(usageResets.kind, kind)),
    )
    .orderBy(desc(usageResets.resetAt))
    .limit(1)
  return rows[0]?.ts ?? 0
}
```

- [ ] **Step 5: Run, verify PASS**

Run: `bun test tests/queries-request-logs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/request-logs.ts src/db/queries/usage-resets.ts tests/queries-request-logs.test.ts
git commit -m "feat(db): request-logs and usage-resets queries"
```

---

### Task 9: `sessions` queries (TDD)

**Files:**
- Create: `tests/queries-sessions.test.ts`
- Create: `src/db/queries/sessions.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { beforeEach, describe, expect, test } from "bun:test"

import {
  createSession,
  deleteSession,
  deleteSessionsForToken,
  expireOldSessions,
  getSessionById,
} from "../src/db/queries/sessions"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
})

describe("sessions queries", () => {
  test("create + get + delete", async () => {
    const id = await createSession({
      authTokenId: 7,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    const row = await getSessionById(id)
    expect(row?.authTokenId).toBe(7)
    expect(row?.isSuperAdmin).toBe(0)
    expect(row?.expiresAt).toBeGreaterThan(Date.now())
    await deleteSession(id)
    expect(await getSessionById(id)).toBeUndefined()
  })

  test("super admin session has null tokenId and flag set", async () => {
    const id = await createSession({
      authTokenId: null,
      isSuperAdmin: true,
      ttlMs: 60_000,
    })
    const row = await getSessionById(id)
    expect(row?.authTokenId).toBeNull()
    expect(row?.isSuperAdmin).toBe(1)
  })

  test("deleteSessionsForToken cascades", async () => {
    const a = await createSession({
      authTokenId: 9,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    const b = await createSession({
      authTokenId: 9,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    await deleteSessionsForToken(9)
    expect(await getSessionById(a)).toBeUndefined()
    expect(await getSessionById(b)).toBeUndefined()
  })

  test("expireOldSessions removes expired", async () => {
    const id = await createSession({
      authTokenId: 1,
      isSuperAdmin: false,
      ttlMs: -1,
    })
    await expireOldSessions()
    expect(await getSessionById(id)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/queries-sessions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { eq, lt } from "drizzle-orm"
import crypto from "node:crypto"

import { getDb } from "../client"
import { sessions } from "../schema"

export interface SessionRow {
  id: string
  authTokenId: number | null
  isSuperAdmin: number
  expiresAt: number
  createdAt: number
}

export async function createSession(input: {
  authTokenId: number | null
  isSuperAdmin: boolean
  ttlMs: number
}): Promise<string> {
  const db = getDb()
  const id = crypto.randomBytes(32).toString("hex")
  const now = Date.now()
  await db.insert(sessions).values({
    id,
    authTokenId: input.authTokenId,
    isSuperAdmin: input.isSuperAdmin ? 1 : 0,
    expiresAt: now + input.ttlMs,
    createdAt: now,
  })
  return id
}

export async function getSessionById(
  id: string,
): Promise<SessionRow | undefined> {
  const db = getDb()
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1)
  return rows[0] as SessionRow | undefined
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb()
  await db.delete(sessions).where(eq(sessions.id, id))
}

export async function deleteSessionsForToken(
  authTokenId: number,
): Promise<void> {
  const db = getDb()
  await db.delete(sessions).where(eq(sessions.authTokenId, authTokenId))
}

export async function expireOldSessions(): Promise<void> {
  const db = getDb()
  await db.delete(sessions).where(lt(sessions.expiresAt, Date.now()))
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `bun test tests/queries-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/sessions.ts tests/queries-sessions.test.ts
git commit -m "feat(db): sessions query helpers"
```

---


## Phase 2 — Auth & usage middleware overhaul

### Task 10: Refactor `state.ts` for multi-auth config

**Files:**
- Modify: `src/lib/state.ts`

- [ ] **Step 1: Replace state.ts content**

Replace existing file content with:

```ts
import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Outbound auth configuration
  authEnabled: boolean
  // The file-resident super admin token (plaintext, kept in memory for compare)
  superAdminToken?: string
  superAdminTokenHash?: string

  // Dashboard / DB configuration
  dashboardEnabled: boolean
  dbPath?: string
  logRetentionDays: number
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  authEnabled: true,
  dashboardEnabled: true,
  logRetentionDays: 90,
}
```

- [ ] **Step 2: Typecheck (will fail in callers)**

Run: `bun run typecheck`
Expected: errors at any reader of `state.authToken`. We will fix each in subsequent tasks. If callers reference removed fields, leave them broken for now — Task 11/12/etc. fix them.

- [ ] **Step 3: Commit**

```bash
git add src/lib/state.ts
git commit -m "refactor(state): replace authToken with super-admin/dashboard fields"
```

---

### Task 11: Update `auth-token.ts` to populate super admin fields

**Files:**
- Modify: `src/lib/auth-token.ts`

- [ ] **Step 1: Replace setupAuthToken**

Replace the existing file with:

```ts
import consola from "consola"
import fs from "node:fs/promises"

import { hashToken, prefixOf } from "~/lib/auth-token-utils"
import { generateToken } from "~/lib/auth-token-utils"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

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
  let generated = false
  if (!token) {
    token = generateToken()
    await saveAuthToken(token)
    generated = true
  }

  state.superAdminToken = token
  state.superAdminTokenHash = hashToken(token)

  if (generated || state.showToken) {
    consola.info(`Super admin token: ${token}`)
  }
  consola.info(`Auth: enabled (super admin prefix: ${prefixOf(token)})`)
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: passes for this file (other files still have errors — fixed in next tasks).

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth-token.ts
git commit -m "refactor(auth): populate super-admin token + hash on setup"
```

---

### Task 12: Rewrite `auth-middleware.ts` (TDD)

**Files:**
- Create: `tests/auth-middleware-multi.test.ts`
- Modify: `src/lib/auth-middleware.ts`
- Delete: `tests/auth-middleware.test.ts` (replaced)

- [ ] **Step 1: Delete the old test file**

```bash
git rm tests/auth-middleware.test.ts
```

- [ ] **Step 2: Write the new failing test**

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { authMiddleware } from "../src/lib/auth-middleware"
import { createAuthToken } from "../src/db/queries/auth-tokens"
import { insertRequestLog } from "../src/db/queries/request-logs"
import { hashToken } from "../src/lib/auth-token-utils"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

const SUPER = "cpk-super000000000000000000000000000000000000000000000000000000000000"

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
})

function makeApp(): Hono {
  const app = new Hono()
  app.use(authMiddleware())
  app.post("/v1/messages", (c) =>
    c.json({ tokenId: c.get("authTokenId") ?? null }),
  )
  return app
}

describe("authMiddleware (multi)", () => {
  test("super admin token passes and sets no tokenId", async () => {
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPER}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tokenId: null })
  })

  test("DB token passes and sets c.authTokenId", async () => {
    const tokenPlain = "cpk-userusr00000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "cpk-user...0000",
    })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tokenId: id })
  })

  test("disabled DB token returns 401", async () => {
    const tokenPlain = "cpk-dis0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
    })
    // disable
    const { updateAuthToken } = await import("../src/db/queries/auth-tokens")
    await updateAuthToken(id, { isDisabled: true })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(401)
  })

  test("RPM limit returns 429", async () => {
    const tokenPlain = "cpk-rpm0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
      rpmLimit: 1,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: Date.now(),
      endpoint: "/v1/messages",
      statusCode: 200,
    })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_exceeded")
  })

  test("monthly limit returns 429", async () => {
    const tokenPlain = "cpk-mon0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
      monthlyTokenLimit: 100,
    })
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    await insertRequestLog({
      authTokenId: id,
      timestamp: monthStart.getTime() + 1,
      endpoint: "/v1/messages",
      statusCode: 200,
      totalTokens: 100,
    })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("monthly_quota_exceeded")
  })

  test("lifetime limit returns 403", async () => {
    const tokenPlain = "cpk-lif0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
      lifetimeTokenLimit: 50,
    })
    const { setLifetimeUsed } = await import("../src/db/queries/auth-tokens")
    await setLifetimeUsed(id, 50)
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("account_quota_exhausted")
  })

  test("unknown token returns 401", async () => {
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer cpk-nope" },
    })
    expect(res.status).toBe(401)
  })

  test("authEnabled=false bypasses everything", async () => {
    state.authEnabled = false
    const res = await makeApp().request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 3: Run, verify FAIL**

Run: `bun test tests/auth-middleware-multi.test.ts`
Expected: FAIL.

- [ ] **Step 4: Rewrite `src/lib/auth-middleware.ts`**

```ts
import type { MiddlewareHandler } from "hono"

import crypto from "node:crypto"

import { findAuthTokenByHash } from "~/db/queries/auth-tokens"
import {
  countRequestsSince,
  sumTokensSince,
} from "~/db/queries/request-logs"
import { latestUsageReset } from "~/db/queries/usage-resets"
import { hashToken } from "~/lib/auth-token-utils"
import { state } from "~/lib/state"

function extractToken(c: {
  req: { header: (name: string) => string | undefined }
}): string | undefined {
  const authHeader = c.req.header("authorization")
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7)
  return c.req.header("x-api-key")
}

function constantTimeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

function jsonError(
  type: string,
  message: string,
  extras: Record<string, unknown> = {},
) {
  return { error: { type, message, ...extras } }
}

function startOfCurrentMonthMs(): number {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!state.authEnabled) return next()

    // Health check stays open
    if (c.req.path === "/healthz") return next()

    const presented = extractToken(c)
    if (!presented) {
      return c.json(
        jsonError(
          "auth_error",
          "Missing auth token. Set Authorization header or x-api-key header.",
        ),
        401,
      )
    }

    // Super admin first
    if (
      state.superAdminTokenHash !== undefined
      && constantTimeEqual(hashToken(presented), state.superAdminTokenHash)
    ) {
      return next()
    }

    // DB token
    const row = await findAuthTokenByHash(hashToken(presented))
    if (!row || row.isDisabled === 1) {
      return c.json(jsonError("auth_error", "Invalid auth token."), 401)
    }

    // RPM
    if (row.rpmLimit !== null && row.rpmLimit > 0) {
      const since = Date.now() - 60_000
      const count = await countRequestsSince(row.id, since)
      if (count >= row.rpmLimit) {
        return c.json(
          jsonError("rate_limit_exceeded", "Per-minute request limit hit.", {
            retry_after_ms: 60_000,
          }),
          429,
        )
      }
    }

    // Monthly
    if (row.monthlyTokenLimit !== null && row.monthlyTokenLimit > 0) {
      const lastReset = await latestUsageReset(row.id, "monthly")
      const since = Math.max(startOfCurrentMonthMs(), lastReset)
      const used = await sumTokensSince(row.id, since)
      if (used >= row.monthlyTokenLimit) {
        return c.json(
          jsonError(
            "monthly_quota_exceeded",
            "Monthly token quota exceeded.",
          ),
          429,
        )
      }
    }

    // Lifetime
    if (
      row.lifetimeTokenLimit !== null
      && row.lifetimeTokenLimit > 0
      && row.lifetimeTokenUsed >= row.lifetimeTokenLimit
    ) {
      return c.json(
        jsonError(
          "account_quota_exhausted",
          "Lifetime token quota exhausted.",
        ),
        403,
      )
    }

    c.set("authTokenId", row.id)
    return next()
  }
}
```

- [ ] **Step 5: Augment Hono context types**

Create `src/types/hono-env.d.ts`:

```ts
declare module "hono" {
  interface ContextVariableMap {
    authTokenId?: number
    sessionRole?: "super" | "admin" | "user"
    sessionTokenId?: number | null
  }
}
export {}
```

- [ ] **Step 6: Run, verify PASS**

Run: `bun test tests/auth-middleware-multi.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/auth-middleware-multi.test.ts src/lib/auth-middleware.ts src/types/hono-env.d.ts
git rm tests/auth-middleware.test.ts 2>/dev/null || true
git commit -m "feat(auth): multi-token auth middleware with limit enforcement"
```

---

### Task 13: `usage-recorder` middleware (TDD)

**Files:**
- Create: `tests/usage-recorder.test.ts`
- Create: `src/lib/usage-recorder.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthToken, getAuthTokenById } from "../src/db/queries/auth-tokens"
import { recentLogs } from "../src/db/queries/request-logs"
import { recordUsage, usageRecorder } from "../src/lib/usage-recorder"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
  state.logRetentionDays = 90
})

describe("usage-recorder", () => {
  test("records a row for an authed business request", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const app = new Hono()
    app.use(async (c, next) => {
      c.set("authTokenId", id)
      await next()
    })
    app.use(usageRecorder())
    app.post("/v1/messages", async (c) => {
      await recordUsage(c, { promptTokens: 3, completionTokens: 5, totalTokens: 8 })
      return c.json({ ok: true })
    })
    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(200)
    const logs = await recentLogs({ tokenId: id, limit: 10 })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.totalTokens).toBe(8)
    expect(logs[0]?.endpoint).toBe("/v1/messages")
    expect(logs[0]?.statusCode).toBe(200)
    const tok = await getAuthTokenById(id)
    expect(tok?.lifetimeTokenUsed).toBe(8)
    expect(tok?.lastUsedAt).toBeGreaterThan(0)
  })

  test("records a row even if recordUsage is never called (no token counts)", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const app = new Hono()
    app.use(async (c, next) => {
      c.set("authTokenId", id)
      await next()
    })
    app.use(usageRecorder())
    app.post("/v1/messages", (c) => c.text("ok"))
    await app.request("/v1/messages", { method: "POST" })
    const logs = await recentLogs({ tokenId: id, limit: 10 })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.totalTokens).toBeNull()
  })

  test("does not record for super admin (no authTokenId)", async () => {
    const app = new Hono()
    app.use(usageRecorder())
    app.post("/v1/messages", (c) => c.text("ok"))
    await app.request("/v1/messages", { method: "POST" })
    const logs = await recentLogs({ limit: 10 })
    expect(logs).toHaveLength(0)
  })

  test("records 5xx with status code", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const app = new Hono()
    app.use(async (c, next) => {
      c.set("authTokenId", id)
      await next()
    })
    app.use(usageRecorder())
    app.post("/v1/messages", (c) => c.json({ err: 1 }, 500))
    await app.request("/v1/messages", { method: "POST" })
    const logs = await recentLogs({ tokenId: id, limit: 10 })
    expect(logs[0]?.statusCode).toBe(500)
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/usage-recorder.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `usage-recorder.ts`**

```ts
import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import {
  incrementLifetimeUsed,
  touchLastUsed,
} from "~/db/queries/auth-tokens"
import {
  insertRequestLog,
  maybePruneOldLogs,
} from "~/db/queries/request-logs"
import { state } from "~/lib/state"

interface PendingUsage {
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  model?: string | null
  recorded?: boolean
}

const STORE = "_usagePending"

function getPending(c: Context): PendingUsage {
  let p = c.get(STORE) as PendingUsage | undefined
  if (!p) {
    p = {}
    c.set(STORE, p)
  }
  return p
}

/**
 * Call from a route handler (or stream completion callback) to attach
 * token-count info to the eventual usage row. Safe to call multiple times;
 * the latest values win.
 */
export function recordUsage(
  c: Context,
  data: Pick<
    PendingUsage,
    "promptTokens" | "completionTokens" | "totalTokens" | "model"
  >,
): void {
  const p = getPending(c)
  if (data.promptTokens !== undefined) p.promptTokens = data.promptTokens
  if (data.completionTokens !== undefined)
    p.completionTokens = data.completionTokens
  if (data.totalTokens !== undefined) p.totalTokens = data.totalTokens
  if (data.model !== undefined) p.model = data.model
}

export function usageRecorder(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now()
    let status = 200
    try {
      await next()
      status = c.res.status
    } catch (err) {
      status = 500
      throw err
    } finally {
      const tokenId = c.get("authTokenId") as number | undefined
      if (tokenId !== undefined) {
        const pending = (c.get(STORE) as PendingUsage | undefined) ?? {}
        const ts = Date.now()
        try {
          await insertRequestLog({
            authTokenId: tokenId,
            timestamp: ts,
            endpoint: c.req.path,
            model: pending.model ?? null,
            promptTokens: pending.promptTokens ?? null,
            completionTokens: pending.completionTokens ?? null,
            totalTokens: pending.totalTokens ?? null,
            statusCode: status,
            latencyMs: ts - startedAt,
          })
          if (pending.totalTokens && pending.totalTokens > 0) {
            await incrementLifetimeUsed(tokenId, pending.totalTokens)
          }
          await touchLastUsed(tokenId, ts)
          await maybePruneOldLogs(state.logRetentionDays * 86_400_000)
        } catch (err) {
          consola.warn("usageRecorder: failed to write log", err)
        }
      }
    }
  }
}
```

- [ ] **Step 4: Add the typed key to `hono-env.d.ts`**

In `src/types/hono-env.d.ts` extend `ContextVariableMap`:

```ts
declare module "hono" {
  interface ContextVariableMap {
    authTokenId?: number
    sessionRole?: "super" | "admin" | "user"
    sessionTokenId?: number | null
    _usagePending?: {
      promptTokens?: number | null
      completionTokens?: number | null
      totalTokens?: number | null
      model?: string | null
      recorded?: boolean
    }
  }
}
export {}
```

- [ ] **Step 5: Run, verify PASS**

Run: `bun test tests/usage-recorder.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/usage-recorder.ts src/types/hono-env.d.ts tests/usage-recorder.test.ts
git commit -m "feat(usage): usage-recorder middleware + recordUsage helper"
```

---

### Task 14: Wire `recordUsage` into chat-completions handler

**Files:**
- Modify: `src/routes/chat-completions/handler.ts`

- [ ] **Step 1: Patch handler to call recordUsage**

In `handleCompletion` after `const response = await createChatCompletions(payload)`, for the non-stream branch:

```ts
if (isNonStreaming(response)) {
  recordUsage(c, {
    model: payload.model,
    promptTokens: response.usage?.prompt_tokens ?? null,
    completionTokens: response.usage?.completion_tokens ?? null,
    totalTokens: response.usage?.total_tokens ?? null,
  })
  return c.json(response)
}
```

For streaming, after the stream-pipe loop is exited (in `pipeOpenAIStream`), we need to capture the final usage frame from upstream chunks. Add an out-parameter so the handler can call `recordUsage` after the stream is done. Simplest patch: pipe a `usage` accumulator object in via closure:

```ts
const usage = { prompt: 0, completion: 0, total: 0 }
return streamSSE(
  c,
  (stream) => pipeOpenAIStream(stream, response, usage),
  (error) => {
    consola.error("streamSSE onError (chat-completions):", error)
    return Promise.resolve()
  },
).finally(() => {
  recordUsage(c, {
    model: payload.model,
    promptTokens: usage.prompt || null,
    completionTokens: usage.completion || null,
    totalTokens: usage.total || null,
  })
})
```

And update `pipeOpenAIStream` signature: `pipeOpenAIStream(stream, response, usage: { prompt: number; completion: number; total: number })`. Inside the chunk loop, parse the SSE data line and if it has `usage` set the fields:

```ts
if (chunk.data && chunk.data !== "[DONE]") {
  try {
    const parsed = JSON.parse(chunk.data)
    if (parsed?.usage) {
      usage.prompt = parsed.usage.prompt_tokens ?? usage.prompt
      usage.completion = parsed.usage.completion_tokens ?? usage.completion
      usage.total = parsed.usage.total_tokens ?? usage.total
    }
  } catch {
    /* not json */
  }
}
```

Add the import: `import { recordUsage } from "~/lib/usage-recorder"`.

- [ ] **Step 2: Run all backend tests**

Run: `bun test`
Expected: PASS for all existing tests; the chat-completions tests still pass since they mock fetch and shape doesn't change.

- [ ] **Step 3: Commit**

```bash
git add src/routes/chat-completions/handler.ts
git commit -m "feat(chat): pipe upstream usage into recordUsage"
```

---

### Task 15: Wire `recordUsage` into messages (Anthropic) handler

**Files:**
- Modify: `src/routes/messages/handler.ts`

- [ ] **Step 1: Non-streaming branch**

After translation, before `return c.json(anthropicResponse)`:

```ts
recordUsage(c, {
  model: openAIPayload.model,
  promptTokens: response.usage?.prompt_tokens ?? null,
  completionTokens: response.usage?.completion_tokens ?? null,
  totalTokens: response.usage?.total_tokens ?? null,
})
```

Add: `import { recordUsage } from "~/lib/usage-recorder"`.

- [ ] **Step 2: Streaming branch**

Same accumulator pattern as Task 14: pass a `usage` object into `runAnthropicStream`. Inside that loop, after `JSON.parse(rawEvent.data)` succeeds, if the chunk has `usage`, accumulate. After `streamSSE(...)`, attach `.finally(() => recordUsage(c, { ...usage }))`.

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/handler.ts
git commit -m "feat(messages): pipe upstream usage into recordUsage"
```

---


## Phase 3 — Admin API: sessions, tokens, usage

### Task 16: Session middleware + cookie helpers (TDD)

**Files:**
- Create: `tests/admin-auth.test.ts`
- Create: `src/lib/session.ts`
- Create: `src/routes/admin/auth.ts`

- [ ] **Step 1: Write failing test for /admin/api/login + /me + /logout**

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthToken } from "../src/db/queries/auth-tokens"
import { hashToken } from "../src/lib/auth-token-utils"
import { adminAuthRoutes } from "../src/routes/admin/auth"
import { sessionMiddleware } from "../src/lib/session"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

const SUPER = "cpk-super000000000000000000000000000000000000000000000000000000000000"

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api", adminAuthRoutes)
  app.use("/admin/api/protected", sessionMiddleware())
  app.get("/admin/api/protected", (c) => c.json({ role: c.get("sessionRole") }))
  return app
}

function getSetCookie(res: Response): string | null {
  return res.headers.get("set-cookie")
}

describe("admin auth", () => {
  test("login with super token sets cookie and /me returns super", async () => {
    const app = makeApp()
    const loginRes = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: SUPER, ttl_days: 1 }),
    })
    expect(loginRes.status).toBe(200)
    expect(((await loginRes.json()) as { role: string }).role).toBe("super")
    const cookie = getSetCookie(loginRes)
    expect(cookie).toContain("cpk_session=")

    const meRes = await app.request("/admin/api/me", {
      headers: { cookie: cookie ?? "" },
    })
    expect(meRes.status).toBe(200)
    const me = (await meRes.json()) as { role: string }
    expect(me.role).toBe("super")
  })

  test("login with DB user token", async () => {
    const tokenPlain = "cpk-user0000000000000000000000000000000000000000000000000000000000000"
    await createAuthToken({
      name: "alice",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "cpk-user...0000",
    })
    const app = makeApp()
    const res = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: tokenPlain, ttl_days: 7 }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { role: string }).role).toBe("user")
  })

  test("login with DB admin token", async () => {
    const tokenPlain = "cpk-admin000000000000000000000000000000000000000000000000000000000000"
    await createAuthToken({
      name: "bob",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "cpk-admi...0000",
      isAdmin: true,
    })
    const app = makeApp()
    const res = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: tokenPlain, ttl_days: 30 }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { role: string }).role).toBe("admin")
  })

  test("login rejects ttl_days outside {1,7,30}", async () => {
    const app = makeApp()
    const res = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: SUPER, ttl_days: 999 }),
    })
    expect(res.status).toBe(400)
  })

  test("login rejects bad token", async () => {
    const app = makeApp()
    const res = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "cpk-bad", ttl_days: 1 }),
    })
    expect(res.status).toBe(401)
  })

  test("logout clears cookie and invalidates session", async () => {
    const app = makeApp()
    const loginRes = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: SUPER, ttl_days: 1 }),
    })
    const cookie = getSetCookie(loginRes) ?? ""
    const out = await app.request("/admin/api/logout", {
      method: "POST",
      headers: { cookie },
    })
    expect(out.status).toBe(200)
    const after = await app.request("/admin/api/me", { headers: { cookie } })
    expect(after.status).toBe(401)
  })

  test("protected route requires session", async () => {
    const app = makeApp()
    const res = await app.request("/admin/api/protected")
    expect(res.status).toBe(401)
  })

  test("dashboard disabled returns 503 from login", async () => {
    state.dashboardEnabled = false
    const app = makeApp()
    const res = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: SUPER, ttl_days: 1 }),
    })
    expect(res.status).toBe(503)
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/admin-auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/session.ts`**

```ts
import type { Context, MiddlewareHandler } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"

import {
  createSession,
  deleteSession,
  getSessionById,
} from "~/db/queries/sessions"
import { getAuthTokenById } from "~/db/queries/auth-tokens"

export const SESSION_COOKIE = "cpk_session"

export interface ResolvedSession {
  role: "super" | "admin" | "user"
  authTokenId: number | null
  name: string
}

export async function startSessionForSuperAdmin(
  c: Context,
  ttlMs: number,
): Promise<void> {
  const id = await createSession({
    authTokenId: null,
    isSuperAdmin: true,
    ttlMs,
  })
  writeSessionCookie(c, id, ttlMs)
}

export async function startSessionForToken(
  c: Context,
  authTokenId: number,
  ttlMs: number,
): Promise<void> {
  const id = await createSession({
    authTokenId,
    isSuperAdmin: false,
    ttlMs,
  })
  writeSessionCookie(c, id, ttlMs)
}

function writeSessionCookie(c: Context, id: string, ttlMs: number): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: c.req.url.startsWith("https://"),
    maxAge: Math.floor(ttlMs / 1000),
  })
}

export async function endCurrentSession(c: Context): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE)
  if (id) await deleteSession(id)
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
}

export async function resolveSession(
  c: Context,
): Promise<ResolvedSession | null> {
  const id = getCookie(c, SESSION_COOKIE)
  if (!id) return null
  const row = await getSessionById(id)
  if (!row || row.expiresAt < Date.now()) return null
  if (row.isSuperAdmin === 1) {
    return { role: "super", authTokenId: null, name: "super-admin" }
  }
  if (row.authTokenId === null) return null
  const tok = await getAuthTokenById(row.authTokenId)
  if (!tok || tok.isDisabled === 1) return null
  return {
    role: tok.isAdmin === 1 ? "admin" : "user",
    authTokenId: tok.id,
    name: tok.name,
  }
}

export function sessionMiddleware(
  options: { requireRole?: "admin" | "super" } = {},
): MiddlewareHandler {
  return async (c, next) => {
    const session = await resolveSession(c)
    if (!session) {
      return c.json(
        { error: { type: "auth_error", message: "Not authenticated" } },
        401,
      )
    }
    if (options.requireRole === "super" && session.role !== "super") {
      return c.json(
        { error: { type: "permission_denied", message: "Super admin required" } },
        403,
      )
    }
    if (
      options.requireRole === "admin"
      && session.role !== "admin"
      && session.role !== "super"
    ) {
      return c.json(
        { error: { type: "permission_denied", message: "Admin required" } },
        403,
      )
    }
    c.set("sessionRole", session.role)
    c.set("sessionTokenId", session.authTokenId)
    await next()
  }
}
```

- [ ] **Step 4: Implement `src/routes/admin/auth.ts`**

```ts
import { Hono } from "hono"
import crypto from "node:crypto"
import { z } from "zod"

import { findAuthTokenByHash } from "~/db/queries/auth-tokens"
import { hashToken } from "~/lib/auth-token-utils"
import {
  endCurrentSession,
  resolveSession,
  startSessionForSuperAdmin,
  startSessionForToken,
} from "~/lib/session"
import { state } from "~/lib/state"

const LoginSchema = z.object({
  key: z.string().min(1),
  ttl_days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
})

function dashboardGate(c: Parameters<typeof Hono.prototype.get>[1] extends infer F ? any : any) {
  return c.json(
    { error: { type: "dashboard_disabled", message: "Dashboard is disabled" } },
    503,
  )
}

export const adminAuthRoutes = new Hono()

adminAuthRoutes.post("/login", async (c) => {
  if (!state.dashboardEnabled || !state.authEnabled) return dashboardGate(c)
  const parsed = LoginSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "Invalid login body" } },
      400,
    )
  }
  const { key, ttl_days } = parsed.data
  const ttlMs = ttl_days * 86_400_000
  const presented = hashToken(key)
  // Super admin first
  if (state.superAdminTokenHash) {
    const matchSuper = (() => {
      try {
        return crypto.timingSafeEqual(
          Buffer.from(presented),
          Buffer.from(state.superAdminTokenHash),
        )
      } catch {
        return false
      }
    })()
    if (matchSuper) {
      await startSessionForSuperAdmin(c, ttlMs)
      return c.json({ role: "super", name: "super-admin" })
    }
  }
  const row = await findAuthTokenByHash(presented)
  if (!row || row.isDisabled === 1) {
    return c.json(
      { error: { type: "auth_error", message: "Invalid auth token." } },
      401,
    )
  }
  await startSessionForToken(c, row.id, ttlMs)
  return c.json({ role: row.isAdmin === 1 ? "admin" : "user", name: row.name })
})

adminAuthRoutes.post("/logout", async (c) => {
  await endCurrentSession(c)
  return c.json({ ok: true })
})

adminAuthRoutes.get("/me", async (c) => {
  const session = await resolveSession(c)
  if (!session) {
    return c.json(
      { error: { type: "auth_error", message: "Not authenticated" } },
      401,
    )
  }
  return c.json(session)
})
```

- [ ] **Step 5: Run, verify PASS**

Run: `bun test tests/admin-auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/session.ts src/routes/admin/auth.ts tests/admin-auth.test.ts
git commit -m "feat(admin): session middleware + login/logout/me endpoints"
```

---

### Task 17: Token CRUD endpoints (TDD)

**Files:**
- Create: `tests/admin-tokens.test.ts`
- Create: `src/routes/admin/tokens.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthToken, getAuthTokenById, listAuthTokens } from "../src/db/queries/auth-tokens"
import { createSession } from "../src/db/queries/sessions"
import { hashToken } from "../src/lib/auth-token-utils"
import { adminTokensRoutes } from "../src/routes/admin/tokens"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

const SUPER = "cpk-super000000000000000000000000000000000000000000000000000000000000"

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api/tokens", adminTokensRoutes)
  return app
}

async function loginAsSuper(): Promise<string> {
  const id = await createSession({
    authTokenId: null,
    isSuperAdmin: true,
    ttlMs: 60_000,
  })
  return `cpk_session=${id}`
}

async function loginAsAdmin(): Promise<{ id: number; cookie: string }> {
  const id = await createAuthToken({
    name: "admin1",
    tokenHash: "ahash",
    tokenPrefix: "p",
    isAdmin: true,
  })
  const sid = await createSession({
    authTokenId: id,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })
  return { id, cookie: `cpk_session=${sid}` }
}

async function loginAsUser(): Promise<{ id: number; cookie: string }> {
  const id = await createAuthToken({
    name: "user1",
    tokenHash: "uhash",
    tokenPrefix: "p",
  })
  const sid = await createSession({
    authTokenId: id,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })
  return { id, cookie: `cpk_session=${sid}` }
}

describe("admin tokens API", () => {
  test("user cannot list", async () => {
    const { cookie } = await loginAsUser()
    const res = await makeApp().request("/admin/api/tokens", {
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })

  test("admin lists tokens", async () => {
    const { cookie } = await loginAsAdmin()
    await createAuthToken({
      name: "x",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const res = await makeApp().request("/admin/api/tokens", {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.length).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain("ahash")
  })

  test("super creates token and gets plaintext exactly once", async () => {
    const cookie = await loginAsSuper()
    const res = await makeApp().request("/admin/api/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "newone" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: number
      token: string
      name: string
    }
    expect(body.token).toMatch(/^cpk-[0-9a-f]{64}$/)
    // Subsequent GETs must NOT return the token
    const list = (await (
      await makeApp().request("/admin/api/tokens", { headers: { cookie } })
    ).json()) as Array<Record<string, unknown>>
    for (const row of list) {
      expect(row).not.toHaveProperty("token")
    }
  })

  test("admin cannot set is_admin=true", async () => {
    const { cookie } = await loginAsAdmin()
    const res = await makeApp().request("/admin/api/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", is_admin: true }),
    })
    expect(res.status).toBe(403)
  })

  test("admin cannot modify another admin", async () => {
    const { cookie } = await loginAsAdmin()
    const otherAdmin = await createAuthToken({
      name: "other-admin",
      tokenHash: "h2",
      tokenPrefix: "p",
      isAdmin: true,
    })
    const res = await makeApp().request(`/admin/api/tokens/${otherAdmin}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    })
    expect(res.status).toBe(403)
  })

  test("admin cannot delete another admin", async () => {
    const { cookie } = await loginAsAdmin()
    const otherAdmin = await createAuthToken({
      name: "x",
      tokenHash: "h2",
      tokenPrefix: "p",
      isAdmin: true,
    })
    const res = await makeApp().request(`/admin/api/tokens/${otherAdmin}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })

  test("super can delete admin and cascades sessions", async () => {
    const cookie = await loginAsSuper()
    const id = await createAuthToken({
      name: "victim",
      tokenHash: "h",
      tokenPrefix: "p",
      isAdmin: true,
    })
    await createSession({
      authTokenId: id,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    const res = await makeApp().request(`/admin/api/tokens/${id}`, {
      method: "DELETE",
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    expect(await getAuthTokenById(id)).toBeUndefined()
  })

  test("admin reset-monthly works on regular token", async () => {
    const { cookie } = await loginAsAdmin()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const res = await makeApp().request(
      `/admin/api/tokens/${id}/reset-monthly`,
      { method: "POST", headers: { cookie } },
    )
    expect(res.status).toBe(200)
  })

  test("admin cannot reset-lifetime", async () => {
    const { cookie } = await loginAsAdmin()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const res = await makeApp().request(
      `/admin/api/tokens/${id}/reset-lifetime`,
      { method: "POST", headers: { cookie } },
    )
    expect(res.status).toBe(403)
  })

  test("super reset-lifetime zeros counter", async () => {
    const cookie = await loginAsSuper()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const { setLifetimeUsed } = await import(
      "../src/db/queries/auth-tokens"
    )
    await setLifetimeUsed(id, 999)
    const res = await makeApp().request(
      `/admin/api/tokens/${id}/reset-lifetime`,
      { method: "POST", headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const tok = await getAuthTokenById(id)
    expect(tok?.lifetimeTokenUsed).toBe(0)
  })

  test("listAuthTokens has the seeded admin", async () => {
    await loginAsAdmin()
    const rows = await listAuthTokens()
    expect(rows.find((r) => r.name === "admin1")).toBeDefined()
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/admin-tokens.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/routes/admin/tokens.ts`**

```ts
import { Hono } from "hono"
import { z } from "zod"

import {
  createAuthToken,
  deleteAuthToken,
  getAuthTokenById,
  listAuthTokens,
  setLifetimeUsed,
  updateAuthToken,
} from "~/db/queries/auth-tokens"
import { deleteSessionsForToken } from "~/db/queries/sessions"
import { appendUsageReset } from "~/db/queries/usage-resets"
import { generateToken, hashToken, prefixOf } from "~/lib/auth-token-utils"
import { sessionMiddleware } from "~/lib/session"

export const adminTokensRoutes = new Hono()

// All token endpoints require admin or super
adminTokensRoutes.use("*", sessionMiddleware({ requireRole: "admin" }))

function publicRow(row: {
  id: number
  name: string
  tokenPrefix: string
  isAdmin: number
  isDisabled: number
  rpmLimit: number | null
  monthlyTokenLimit: number | null
  lifetimeTokenLimit: number | null
  lifetimeTokenUsed: number
  createdAt: number
  lastUsedAt: number | null
}) {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.tokenPrefix,
    is_admin: row.isAdmin === 1,
    is_disabled: row.isDisabled === 1,
    rpm_limit: row.rpmLimit,
    monthly_token_limit: row.monthlyTokenLimit,
    lifetime_token_limit: row.lifetimeTokenLimit,
    lifetime_token_used: row.lifetimeTokenUsed,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
  }
}

adminTokensRoutes.get("/", async (c) => {
  const rows = await listAuthTokens()
  return c.json(rows.map(publicRow))
})

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  is_admin: z.boolean().optional(),
  rpm_limit: z.number().int().positive().nullable().optional(),
  monthly_token_limit: z.number().int().positive().nullable().optional(),
  lifetime_token_limit: z.number().int().positive().nullable().optional(),
})

adminTokensRoutes.post("/", async (c) => {
  const role = c.get("sessionRole")
  const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "Invalid body" } },
      400,
    )
  }
  if (parsed.data.is_admin && role !== "super") {
    return c.json(
      {
        error: {
          type: "permission_denied",
          message: "Only super admin can create admin tokens",
        },
      },
      403,
    )
  }
  const plaintext = generateToken()
  const id = await createAuthToken({
    name: parsed.data.name,
    tokenHash: hashToken(plaintext),
    tokenPrefix: prefixOf(plaintext),
    isAdmin: parsed.data.is_admin ?? false,
    rpmLimit: parsed.data.rpm_limit ?? null,
    monthlyTokenLimit: parsed.data.monthly_token_limit ?? null,
    lifetimeTokenLimit: parsed.data.lifetime_token_limit ?? null,
    createdBy: c.get("sessionTokenId") ?? null,
  })
  const row = await getAuthTokenById(id)
  if (!row) throw new Error("post-insert lookup failed")
  return c.json({ ...publicRow(row), token: plaintext })
})

const PatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_admin: z.boolean().optional(),
  is_disabled: z.boolean().optional(),
  rpm_limit: z.number().int().positive().nullable().optional(),
  monthly_token_limit: z.number().int().positive().nullable().optional(),
  lifetime_token_limit: z.number().int().positive().nullable().optional(),
})

async function loadTargetOr404(c: any, id: number) {
  const row = await getAuthTokenById(id)
  if (!row) {
    return [
      undefined,
      c.json({ error: { type: "not_found", message: "Token not found" } }, 404),
    ] as const
  }
  return [row, undefined] as const
}

adminTokensRoutes.patch("/:id", async (c) => {
  const role = c.get("sessionRole")
  const id = Number.parseInt(c.req.param("id"), 10)
  const [row, errResp] = await loadTargetOr404(c, id)
  if (errResp) return errResp
  if (role !== "super" && row.isAdmin === 1) {
    return c.json(
      { error: { type: "permission_denied", message: "Cannot modify another admin" } },
      403,
    )
  }
  const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "Invalid body" } },
      400,
    )
  }
  if (parsed.data.is_admin !== undefined && role !== "super") {
    return c.json(
      { error: { type: "permission_denied", message: "Only super admin can change admin flag" } },
      403,
    )
  }
  await updateAuthToken(id, {
    name: parsed.data.name,
    isAdmin: parsed.data.is_admin,
    isDisabled: parsed.data.is_disabled,
    rpmLimit: parsed.data.rpm_limit,
    monthlyTokenLimit: parsed.data.monthly_token_limit,
    lifetimeTokenLimit: parsed.data.lifetime_token_limit,
  })
  if (parsed.data.is_disabled === true) {
    await deleteSessionsForToken(id)
  }
  const updated = await getAuthTokenById(id)
  return c.json(publicRow(updated!))
})

adminTokensRoutes.delete("/:id", async (c) => {
  const role = c.get("sessionRole")
  const id = Number.parseInt(c.req.param("id"), 10)
  const [row, errResp] = await loadTargetOr404(c, id)
  if (errResp) return errResp
  if (role !== "super" && row.isAdmin === 1) {
    return c.json(
      { error: { type: "permission_denied", message: "Cannot delete another admin" } },
      403,
    )
  }
  await deleteSessionsForToken(id)
  await deleteAuthToken(id)
  return c.json({ ok: true })
})

adminTokensRoutes.post("/:id/reset-monthly", async (c) => {
  const role = c.get("sessionRole")
  const id = Number.parseInt(c.req.param("id"), 10)
  const [row, errResp] = await loadTargetOr404(c, id)
  if (errResp) return errResp
  if (role !== "super" && row.isAdmin === 1) {
    return c.json(
      { error: { type: "permission_denied", message: "Cannot reset another admin" } },
      403,
    )
  }
  await appendUsageReset(id, "monthly", Date.now())
  return c.json({ ok: true })
})

adminTokensRoutes.post("/:id/reset-lifetime", async (c) => {
  const role = c.get("sessionRole")
  if (role !== "super") {
    return c.json(
      { error: { type: "permission_denied", message: "Super admin required" } },
      403,
    )
  }
  const id = Number.parseInt(c.req.param("id"), 10)
  const [, errResp] = await loadTargetOr404(c, id)
  if (errResp) return errResp
  await setLifetimeUsed(id, 0)
  await appendUsageReset(id, "lifetime", Date.now())
  return c.json({ ok: true })
})
```

- [ ] **Step 4: Run, verify PASS**

Run: `bun test tests/admin-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/tokens.ts tests/admin-tokens.test.ts
git commit -m "feat(admin): tokens CRUD + reset endpoints with role enforcement"
```

---

### Task 18: Usage endpoints (TDD)

**Files:**
- Create: `tests/admin-usage.test.ts`
- Create: `src/routes/admin/usage.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthToken } from "../src/db/queries/auth-tokens"
import { insertRequestLog } from "../src/db/queries/request-logs"
import { createSession } from "../src/db/queries/sessions"
import { adminUsageRoutes } from "../src/routes/admin/usage"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api/usage", adminUsageRoutes)
  return app
}

async function asUser(tokenId: number): Promise<string> {
  const sid = await createSession({
    authTokenId: tokenId,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })
  return `cpk_session=${sid}`
}

async function asAdmin(): Promise<string> {
  const id = await createAuthToken({
    name: "a",
    tokenHash: "ah",
    tokenPrefix: "p",
    isAdmin: true,
  })
  return asUser(id)
}

describe("admin usage API", () => {
  test("summary for me returns own counts", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
      monthlyTokenLimit: 1000,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: Date.now(),
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 50,
    })
    const cookie = await asUser(id)
    const res = await makeApp().request(
      "/admin/api/usage/summary?token_id=me",
      { headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      requests_today: number
      tokens_today: number
      monthly_used: number
      monthly_limit: number | null
    }
    expect(body.requests_today).toBe(1)
    expect(body.tokens_today).toBe(50)
    expect(body.monthly_used).toBe(50)
    expect(body.monthly_limit).toBe(1000)
  })

  test("user cannot request token_id=all", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const cookie = await asUser(id)
    const res = await makeApp().request(
      "/admin/api/usage/summary?token_id=all",
      { headers: { cookie } },
    )
    expect(res.status).toBe(403)
  })

  test("admin per-token returns row per token", async () => {
    const cookie = await asAdmin()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: Date.now(),
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 7,
    })
    const res = await makeApp().request(
      `/admin/api/usage/per-token?from=0&to=${Date.now() + 1000}`,
      { headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string; tokens: number }>
    expect(body.find((r) => r.name === "u")?.tokens).toBe(7)
  })

  test("timeseries day buckets", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const cookie = await asUser(id)
    const day = 86_400_000
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 5,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 1,
    })
    const res = await makeApp().request(
      `/admin/api/usage/timeseries?token_id=me&from=0&to=${day * 6}&bucket=day`,
      { headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ requests: number }>
    expect(body).toHaveLength(1)
    expect(body[0]?.requests).toBe(1)
  })

  test("recent returns last N for me", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const cookie = await asUser(id)
    for (let i = 0; i < 3; i++) {
      await insertRequestLog({
        authTokenId: id,
        timestamp: i,
        endpoint: "/x",
        statusCode: 200,
      })
    }
    const res = await makeApp().request(
      "/admin/api/usage/recent?token_id=me&limit=2",
      { headers: { cookie } },
    )
    const body = (await res.json()) as Array<{ timestamp: number }>
    expect(body.map((r) => r.timestamp)).toEqual([2, 1])
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/admin-usage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/routes/admin/usage.ts`**

```ts
import { Hono } from "hono"
import { z } from "zod"

import {
  getAuthTokenById,
  listAuthTokens,
} from "~/db/queries/auth-tokens"
import {
  countRequestsSince,
  recentLogs,
  sumTokensSince,
  timeseriesByBucket,
  type Bucket,
} from "~/db/queries/request-logs"
import { latestUsageReset } from "~/db/queries/usage-resets"
import { sessionMiddleware } from "~/lib/session"

export const adminUsageRoutes = new Hono()

adminUsageRoutes.use("*", sessionMiddleware())

function startOfTodayMs(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfMonthMs(): number {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function resolveTokenId(
  c: any,
  raw: string | undefined,
): { kind: "all" | "id"; id?: number } | { error: Response } {
  const role = c.get("sessionRole")
  const sessionTokenId = c.get("sessionTokenId") as number | null | undefined
  if (raw === "all") {
    if (role !== "admin" && role !== "super") {
      return {
        error: c.json(
          { error: { type: "permission_denied", message: "Admin required" } },
          403,
        ),
      }
    }
    return { kind: "all" }
  }
  if (raw === undefined || raw === "me") {
    if (sessionTokenId === null || sessionTokenId === undefined) {
      // Super admin asking for "me" - default to all
      return { kind: "all" }
    }
    return { kind: "id", id: sessionTokenId }
  }
  const id = Number.parseInt(raw, 10)
  if (!Number.isFinite(id)) {
    return {
      error: c.json(
        { error: { type: "bad_request", message: "bad token_id" } },
        400,
      ),
    }
  }
  if (
    role === "user"
    && (sessionTokenId === null || sessionTokenId !== id)
  ) {
    return {
      error: c.json(
        {
          error: {
            type: "permission_denied",
            message: "Cannot view another token",
          },
        },
        403,
      ),
    }
  }
  return { kind: "id", id }
}

adminUsageRoutes.get("/summary", async (c) => {
  const resolved = resolveTokenId(c, c.req.query("token_id"))
  if ("error" in resolved) return resolved.error
  if (resolved.kind === "all") {
    // Aggregate across all DB tokens
    const rows = await listAuthTokens()
    const todayStart = startOfTodayMs()
    let reqToday = 0
    let tokToday = 0
    let monthlyUsed = 0
    for (const r of rows) {
      reqToday += await countRequestsSince(r.id, todayStart)
      tokToday += await sumTokensSince(r.id, todayStart)
      const reset = await latestUsageReset(r.id, "monthly")
      const since = Math.max(startOfMonthMs(), reset)
      monthlyUsed += await sumTokensSince(r.id, since)
    }
    return c.json({
      requests_today: reqToday,
      tokens_today: tokToday,
      monthly_used: monthlyUsed,
      monthly_limit: null,
      lifetime_used: rows.reduce((s, r) => s + r.lifetimeTokenUsed, 0),
      lifetime_limit: null,
    })
  }
  const id = resolved.id!
  const tok = await getAuthTokenById(id)
  if (!tok) {
    return c.json(
      { error: { type: "not_found", message: "token not found" } },
      404,
    )
  }
  const todayStart = startOfTodayMs()
  const reset = await latestUsageReset(id, "monthly")
  const since = Math.max(startOfMonthMs(), reset)
  return c.json({
    requests_today: await countRequestsSince(id, todayStart),
    tokens_today: await sumTokensSince(id, todayStart),
    monthly_used: await sumTokensSince(id, since),
    monthly_limit: tok.monthlyTokenLimit,
    lifetime_used: tok.lifetimeTokenUsed,
    lifetime_limit: tok.lifetimeTokenLimit,
  })
})

const TimeseriesSchema = z.object({
  from: z.coerce.number(),
  to: z.coerce.number(),
  bucket: z.enum(["hour", "day", "week", "month"]),
})

adminUsageRoutes.get("/timeseries", async (c) => {
  const resolved = resolveTokenId(c, c.req.query("token_id"))
  if ("error" in resolved) return resolved.error
  const parsed = TimeseriesSchema.safeParse({
    from: c.req.query("from"),
    to: c.req.query("to"),
    bucket: c.req.query("bucket"),
  })
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "from/to/bucket required" } },
      400,
    )
  }
  const rows = await timeseriesByBucket({
    tokenId: resolved.kind === "all" ? "all" : resolved.id,
    from: parsed.data.from,
    to: parsed.data.to,
    bucket: parsed.data.bucket as Bucket,
  })
  return c.json(rows)
})

adminUsageRoutes.get("/per-token", async (c) => {
  const role = c.get("sessionRole")
  if (role !== "admin" && role !== "super") {
    return c.json(
      { error: { type: "permission_denied", message: "Admin required" } },
      403,
    )
  }
  const from = Number.parseInt(c.req.query("from") ?? "0", 10)
  const to = Number.parseInt(
    c.req.query("to") ?? String(Date.now() + 1),
    10,
  )
  const rows = await listAuthTokens()
  const out = []
  for (const r of rows) {
    const requests = await countRequestsSince(r.id, from)
    const tokens = await sumTokensSince(r.id, from)
    out.push({
      id: r.id,
      name: r.name,
      requests,
      tokens,
      monthly_pct:
        r.monthlyTokenLimit && r.monthlyTokenLimit > 0
          ? Math.min(100, Math.round((tokens / r.monthlyTokenLimit) * 100))
          : null,
      last_used_at: r.lastUsedAt,
    })
    void to
  }
  return c.json(out)
})

adminUsageRoutes.get("/recent", async (c) => {
  const resolved = resolveTokenId(c, c.req.query("token_id"))
  if ("error" in resolved) return resolved.error
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(c.req.query("limit") ?? "50", 10)),
  )
  const rows = await recentLogs({
    tokenId: resolved.kind === "id" ? resolved.id : undefined,
    limit,
  })
  return c.json(rows)
})
```

- [ ] **Step 4: Run, verify PASS**

Run: `bun test tests/admin-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/usage.ts tests/admin-usage.test.ts
git commit -m "feat(admin): usage summary/timeseries/per-token/recent endpoints"
```

---

### Task 19: Mount admin subapp

**Files:**
- Create: `src/routes/admin/route.ts`

- [ ] **Step 1: Write the file**

```ts
import { Hono } from "hono"

import { adminAuthRoutes } from "./auth"
import { adminTokensRoutes } from "./tokens"
import { adminUsageRoutes } from "./usage"

export const adminRoutes = new Hono()

adminRoutes.route("/", adminAuthRoutes)
adminRoutes.route("/tokens", adminTokensRoutes)
adminRoutes.route("/usage", adminUsageRoutes)
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/route.ts
git commit -m "feat(admin): subapp router"
```

---


## Phase 4 — Server wiring, CLI, static SPA, redacting logger

### Task 20: Redacting logger (TDD)

**Files:**
- Create: `tests/redacting-logger.test.ts`
- Create: `src/lib/redacting-logger.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from "bun:test"

import { redactKeyParam } from "../src/lib/redacting-logger"

describe("redactKeyParam", () => {
  test("removes ?key=...", () => {
    expect(redactKeyParam("/foo?key=cpk-secret&x=1")).toBe("/foo?key=REDACTED&x=1")
  })
  test("untouched without key", () => {
    expect(redactKeyParam("/foo?x=1")).toBe("/foo?x=1")
  })
  test("handles trailing key", () => {
    expect(redactKeyParam("/?key=abc")).toBe("/?key=REDACTED")
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bun test tests/redacting-logger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { MiddlewareHandler } from "hono"

import consola from "consola"

export function redactKeyParam(url: string): string {
  return url.replace(/([?&])key=[^&]*/g, "$1key=REDACTED")
}

export function redactingLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now()
    await next()
    const elapsed = Date.now() - start
    const safe = redactKeyParam(c.req.url)
    consola.info(`${c.req.method} ${safe} ${c.res.status} ${elapsed}ms`)
  }
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `bun test tests/redacting-logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/redacting-logger.ts tests/redacting-logger.test.ts
git commit -m "feat(log): redacting logger middleware"
```

---

### Task 21: Static SPA handler

**Files:**
- Create: `src/lib/static-spa.ts`

- [ ] **Step 1: Write the file**

```ts
import type { MiddlewareHandler } from "hono"

import fs from "node:fs"
import path from "node:path"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function contentType(filePath: string): string {
  return TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
}

export function staticSpa(rootDir: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET") return next()
    const url = new URL(c.req.url)
    const requested = url.pathname === "/" ? "/index.html" : url.pathname
    const candidate = path.join(rootDir, requested)
    // Prevent escaping the root
    const resolved = path.resolve(candidate)
    if (!resolved.startsWith(path.resolve(rootDir))) return next()
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const buf = fs.readFileSync(resolved)
      return c.body(buf, 200, { "content-type": contentType(resolved) })
    }
    // SPA fallback to index.html
    const indexPath = path.join(rootDir, "index.html")
    if (fs.existsSync(indexPath)) {
      const buf = fs.readFileSync(indexPath)
      return c.body(buf, 200, { "content-type": "text/html; charset=utf-8" })
    }
    return next()
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/static-spa.ts
git commit -m "feat(server): static SPA handler with index fallback"
```

---

### Task 22: Wire up `server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Replace file**

```ts
import path from "node:path"

import { Hono } from "hono"
import { cors } from "hono/cors"

import { authMiddleware } from "./lib/auth-middleware"
import { redactingLogger } from "./lib/redacting-logger"
import { state } from "./lib/state"
import { staticSpa } from "./lib/static-spa"
import { usageRecorder } from "./lib/usage-recorder"
import { adminRoutes } from "./routes/admin/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(redactingLogger())
server.use(cors())

server.get("/healthz", (c) => c.text("ok"))

// Admin API: bypass business auth, has its own session middleware per route
server.route("/admin/api", adminRoutes)

// Business API: behind authMiddleware + usage recorder
server.use(authMiddleware())
server.use(usageRecorder())

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token", tokenRoute)

server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/messages", messageRoutes)

// Static SPA fallback (must be last)
const SPA_ROOT = path.resolve(import.meta.dir, "..", "dist", "public")
server.use(staticSpa(SPA_ROOT))
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): mount admin API, usage recorder, redacting logger, static SPA"
```

---

### Task 23: CLI: `--db-path`, `--log-retention-days`, `--no-dashboard`, init DB

**Files:**
- Modify: `src/start.ts`

- [ ] **Step 1: Add new args to the citty schema**

In `defineCommand({ args: { … } })` add:

```ts
"db-path": {
  type: "string",
  description:
    "Path to SQLite DB file (default ~/.local/share/copilot-api/copilot-api.db)",
},
"log-retention-days": {
  type: "string",
  default: "90",
  description: "Days to retain request_logs",
},
dashboard: {
  type: "boolean",
  default: true,
  description: "Enable admin dashboard + API (--no-dashboard to disable)",
},
```

- [ ] **Step 2: Add fields to `RunServerOptions` and `runServer`**

```ts
interface RunServerOptions {
  // … existing fields …
  dbPath?: string
  logRetentionDays: number
  dashboard: boolean
}
```

- [ ] **Step 3: Initialize DB and session sweeper in `runServer`**

After `await ensurePaths()` and before `setupGitHubToken`:

```ts
import { initDb } from "./db/client"
import { expireOldSessions } from "./db/queries/sessions"
import { PATHS } from "./lib/paths"

// inside runServer:
state.dbPath = options.dbPath ?? PATHS.DB_PATH
state.logRetentionDays = options.logRetentionDays
state.dashboardEnabled = options.dashboard
initDb(state.dbPath)
```

After `await setupAuthToken()`:

```ts
// hourly session cleanup
setInterval(() => {
  void expireOldSessions().catch(() => {})
}, 60 * 60 * 1000)
```

- [ ] **Step 4: Pass new args from `run()`**

```ts
return runServer({
  // … existing fields …
  dbPath: args["db-path"],
  logRetentionDays: Number.parseInt(args["log-retention-days"], 10) || 90,
  dashboard: args.dashboard,
})
```

- [ ] **Step 5: Banner**

After existing `consola.box(...)` add:

```ts
if (state.dashboardEnabled) {
  consola.box(
    `📊 Dashboard: ${serverUrl}/?key=${state.superAdminToken ?? "<your-token>"}`,
  )
}
```

- [ ] **Step 6: Run all backend tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/start.ts
git commit -m "feat(cli): add db-path, log-retention-days, dashboard flags + DB init"
```

---

### Task 24: `.gitignore` updates

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add lines**

Append to `.gitignore`:
```
dist/public
frontend/node_modules
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore(git): ignore dist/public and frontend/node_modules"
```

---

### Task 25: Backend smoke run

**Files:** none (manual verification)

- [ ] **Step 1: Run typecheck and full tests**

Run:
```bash
bun run typecheck && bun test
```
Expected: green.

- [ ] **Step 2: Run lint**

Run: `bun run lint .`
Expected: no errors. Fix any flagged issues without changing behavior.

- [ ] **Step 3: Commit (if lint fixes were needed)**

```bash
git add -A
git commit -m "chore(lint): tidy after auth/usage refactor"
```

---


## Phase 5 — Frontend: Vite project + Login + Layout

### Task 26: Bootstrap `frontend/`

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`

- [ ] **Step 1: `frontend/package.json`**

```json
{
  "name": "copilot-api-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "bun test"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0",
    "recharts": "^2.13.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "typescript": "^5.6.3",
    "vite": "^5.4.10"
  }
}
```

- [ ] **Step 2: `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `frontend/vite.config.ts`**

```ts
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/admin/api": "http://localhost:4141",
    },
  },
})
```

- [ ] **Step 4: `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Copilot API Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Install**

Run: `cd frontend && bun install`
Expected: lockfile created, no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/tsconfig.json frontend/vite.config.ts frontend/index.html frontend/bun.lock
git commit -m "feat(frontend): bootstrap Vite + React project"
```

---

### Task 27: Frontend types + API client

**Files:**
- Create: `frontend/src/types.ts`
- Create: `frontend/src/api/client.ts`

- [ ] **Step 1: `frontend/src/types.ts`**

```ts
export type Role = "super" | "admin" | "user"

export interface MeResponse {
  role: Role
  authTokenId: number | null
  name: string
}

export interface TokenRow {
  id: number
  name: string
  token_prefix: string
  is_admin: boolean
  is_disabled: boolean
  rpm_limit: number | null
  monthly_token_limit: number | null
  lifetime_token_limit: number | null
  lifetime_token_used: number
  created_at: number
  last_used_at: number | null
}

export interface CreatedToken extends TokenRow {
  token: string
}

export interface UsageSummary {
  requests_today: number
  tokens_today: number
  monthly_used: number
  monthly_limit: number | null
  lifetime_used: number
  lifetime_limit: number | null
}

export interface TimeseriesPoint {
  bucketStart: number
  requests: number
  tokens: number
  authTokenId: number | null
}

export interface PerTokenRow {
  id: number
  name: string
  requests: number
  tokens: number
  monthly_pct: number | null
  last_used_at: number | null
}

export interface RecentLog {
  id: number
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  statusCode: number
  latencyMs: number | null
}

export type Bucket = "hour" | "day" | "week" | "month"
```

- [ ] **Step 2: `frontend/src/api/client.ts`**

```ts
import type {
  CreatedToken,
  MeResponse,
  PerTokenRow,
  RecentLog,
  TimeseriesPoint,
  TokenRow,
  UsageSummary,
} from "../types"

const BASE = "/admin/api"

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${text}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  login: (key: string, ttlDays: number) =>
    request<MeResponse>("/login", {
      method: "POST",
      body: JSON.stringify({ key, ttl_days: ttlDays }),
    }),
  logout: () => request<void>("/logout", { method: "POST" }),
  me: () => request<MeResponse>("/me"),

  listTokens: () => request<Array<TokenRow>>("/tokens"),
  createToken: (input: {
    name: string
    is_admin?: boolean
    rpm_limit?: number | null
    monthly_token_limit?: number | null
    lifetime_token_limit?: number | null
  }) =>
    request<CreatedToken>("/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patchToken: (id: number, patch: Partial<TokenRow>) =>
    request<TokenRow>(`/tokens/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteToken: (id: number) =>
    request<void>(`/tokens/${id}`, { method: "DELETE" }),
  resetMonthly: (id: number) =>
    request<void>(`/tokens/${id}/reset-monthly`, { method: "POST" }),
  resetLifetime: (id: number) =>
    request<void>(`/tokens/${id}/reset-lifetime`, { method: "POST" }),

  summary: (tokenId: number | "me" | "all") =>
    request<UsageSummary>(`/usage/summary?token_id=${tokenId}`),
  timeseries: (params: {
    tokenId: number | "me" | "all"
    from: number
    to: number
    bucket: string
  }) =>
    request<Array<TimeseriesPoint>>(
      `/usage/timeseries?token_id=${params.tokenId}&from=${params.from}&to=${params.to}&bucket=${params.bucket}`,
    ),
  perToken: (from: number, to: number) =>
    request<Array<PerTokenRow>>(
      `/usage/per-token?from=${from}&to=${to}`,
    ),
  recent: (tokenId: number | "me" | "all", limit = 50) =>
    request<Array<RecentLog>>(
      `/usage/recent?token_id=${tokenId}&limit=${limit}`,
    ),
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts
git commit -m "feat(frontend): types + API client"
```

---

### Task 28: Bucket helper (TDD pure utility)

**Files:**
- Create: `frontend/src/lib/bucket.ts`
- Create: `frontend/src/lib/bucket.test.ts`

- [ ] **Step 1: Write failing test (`bucket.test.ts`)**

```ts
import { describe, expect, test } from "bun:test"

import { suggestBucket } from "./bucket"

describe("suggestBucket", () => {
  test("range <=2 days → hour", () => {
    expect(suggestBucket(0, 2 * 86_400_000)).toBe("hour")
  })
  test("range <=60 days → day", () => {
    expect(suggestBucket(0, 30 * 86_400_000)).toBe("day")
  })
  test("range <=365 days → week", () => {
    expect(suggestBucket(0, 200 * 86_400_000)).toBe("week")
  })
  test("range >365 days → month", () => {
    expect(suggestBucket(0, 800 * 86_400_000)).toBe("month")
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd frontend && bun test src/lib/bucket.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement (`bucket.ts`)**

```ts
import type { Bucket } from "../types"

const DAY = 86_400_000

export function suggestBucket(from: number, to: number): Bucket {
  const span = to - from
  if (span <= 2 * DAY) return "hour"
  if (span <= 60 * DAY) return "day"
  if (span <= 365 * DAY) return "week"
  return "month"
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd frontend && bun test src/lib/bucket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/bucket.ts frontend/src/lib/bucket.test.ts
git commit -m "feat(frontend): suggestBucket utility"
```

---

### Task 29: AuthContext + main entry + App router

**Files:**
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/contexts/AuthContext.tsx`
- Create: `frontend/src/styles.css`

- [ ] **Step 1: `frontend/src/styles.css`**

```css
:root {
  --bg: #0f1115;
  --panel: #161a22;
  --border: #2a2f3a;
  --text: #e6e9ef;
  --muted: #8b93a7;
  --accent: #4f8cff;
  --danger: #ff5c5c;
  --ok: #4caf50;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
}
a { color: var(--accent); text-decoration: none; }
button {
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); padding: 6px 12px; border-radius: 6px;
  cursor: pointer;
}
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: white; }
button.danger { color: var(--danger); }
input, select {
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); padding: 6px 10px; border-radius: 6px;
}
.layout { display: flex; height: 100vh; }
.sidebar { width: 220px; background: var(--panel); border-right: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.sidebar .who { padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
.sidebar .role { font-size: 11px; color: var(--muted); text-transform: uppercase; }
.sidebar nav a { display: block; padding: 8px 10px; border-radius: 6px; color: var(--text); }
.sidebar nav a.active { background: var(--bg); }
.sidebar .spacer { flex: 1; }
.main { flex: 1; padding: 24px; overflow: auto; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; }
.card .value { font-size: 22px; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
th { color: var(--muted); font-weight: 500; }
tr:last-child td { border-bottom: 0; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
.dialog-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }
.dialog { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; min-width: 400px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field label { color: var(--muted); font-size: 12px; }
.error { color: var(--danger); }
.ok { color: var(--ok); }
.center { display: flex; align-items: center; justify-content: center; height: 100%; }
```

- [ ] **Step 2: `frontend/src/contexts/AuthContext.tsx`**

```tsx
import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"

import { api } from "../api/client"
import type { MeResponse } from "../types"

interface AuthState {
  me: MeResponse | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const m = await api.me()
      setMe(m)
    } catch {
      setMe(null)
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    try {
      await api.logout()
    } finally {
      setMe(null)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Ctx.Provider value={{ me, loading, refresh, logout }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error("AuthProvider missing")
  return v
}
```

- [ ] **Step 3: `frontend/src/main.tsx`**

```tsx
import React from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"

import { App } from "./App"
import { AuthProvider } from "./contexts/AuthContext"
import "./styles.css"

const el = document.getElementById("root")
if (!el) throw new Error("root not found")

createRoot(el).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
```

- [ ] **Step 4: `frontend/src/App.tsx`**

```tsx
import { Navigate, Route, Routes } from "react-router-dom"

import { Layout } from "./components/Layout"
import { useAuth } from "./contexts/AuthContext"
import { Login } from "./pages/Login"
import { Overview } from "./pages/Overview"
import { Settings } from "./pages/Settings"
import { Tokens } from "./pages/Tokens"
import { Usage } from "./pages/Usage"

export function App() {
  const { me, loading } = useAuth()
  if (loading) return <div className="center">Loading…</div>
  if (!me) return <Login />
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route
          path="/tokens"
          element={
            me.role === "user" ? <Navigate to="/overview" replace /> : <Tokens />
          }
        />
        <Route path="/usage" element={<Usage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </Layout>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/main.tsx frontend/src/App.tsx frontend/src/contexts/AuthContext.tsx frontend/src/styles.css
git commit -m "feat(frontend): app shell + auth context + global styles"
```

---

### Task 30: Login page + Layout component

**Files:**
- Create: `frontend/src/pages/Login.tsx`
- Create: `frontend/src/components/Layout.tsx`

- [ ] **Step 1: `frontend/src/pages/Login.tsx`**

```tsx
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

import { api } from "../api/client"
import { useAuth } from "../contexts/AuthContext"

const TTL_KEY = "cpk_preferred_ttl"

export function Login() {
  const { refresh } = useAuth()
  const nav = useNavigate()
  const [keyInput, setKeyInput] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const url = new URL(window.location.href)
    const key = url.searchParams.get("key")
    if (!key) return
    const ttl = Number.parseInt(
      window.localStorage.getItem(TTL_KEY) ?? "1",
      10,
    )
    setBusy(true)
    api
      .login(key, [1, 7, 30].includes(ttl) ? ttl : 1)
      .then(async () => {
        window.history.replaceState(null, "", "/")
        await refresh()
        nav("/overview", { replace: true })
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const ttl = Number.parseInt(
      window.localStorage.getItem(TTL_KEY) ?? "1",
      10,
    )
    try {
      await api.login(keyInput, [1, 7, 30].includes(ttl) ? ttl : 1)
      await refresh()
      nav("/overview", { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <form
        onSubmit={submit}
        style={{
          background: "var(--panel)",
          padding: 24,
          borderRadius: 8,
          border: "1px solid var(--border)",
          minWidth: 360,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Copilot API Dashboard</h2>
        <div className="field">
          <label>Auth token</label>
          <input
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="cpk-…"
            autoFocus
          />
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="primary" disabled={busy || !keyInput}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: `frontend/src/components/Layout.tsx`**

```tsx
import type { ReactNode } from "react"

import { NavLink } from "react-router-dom"

import { useAuth } from "../contexts/AuthContext"

export function Layout({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth()
  if (!me) return null
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="who">
          <div>{me.name}</div>
          <div className="role">{me.role}</div>
        </div>
        <nav>
          <NavLink to="/overview">Overview</NavLink>
          {me.role !== "user" && <NavLink to="/tokens">Tokens</NavLink>}
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        <button onClick={() => void logout()}>Logout</button>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Login.tsx frontend/src/components/Layout.tsx
git commit -m "feat(frontend): login page + sidebar layout"
```

---


## Phase 6 — Frontend: Tokens page

### Task 31: TokenFormDialog + ConfirmDialog components

**Files:**
- Create: `frontend/src/components/ConfirmDialog.tsx`
- Create: `frontend/src/components/TokenFormDialog.tsx`

- [ ] **Step 1: `ConfirmDialog.tsx`**

```tsx
import type { ReactNode } from "react"

export function ConfirmDialog(props: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!props.open) return null
  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{props.title}</h3>
        <div style={{ marginBottom: 16 }}>{props.body}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onCancel}>Cancel</button>
          <button
            className={props.destructive ? "danger" : "primary"}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `TokenFormDialog.tsx`**

```tsx
import { useEffect, useState } from "react"

import type { TokenRow } from "../types"

export interface TokenFormValues {
  name: string
  is_admin: boolean
  rpm_limit: number | null
  monthly_token_limit: number | null
  lifetime_token_limit: number | null
}

export function TokenFormDialog(props: {
  open: boolean
  initial?: TokenRow
  canEditAdminFlag: boolean
  onCancel: () => void
  onSubmit: (v: TokenFormValues) => void
}) {
  const [values, setValues] = useState<TokenFormValues>({
    name: "",
    is_admin: false,
    rpm_limit: null,
    monthly_token_limit: null,
    lifetime_token_limit: null,
  })

  useEffect(() => {
    if (!props.open) return
    if (props.initial) {
      setValues({
        name: props.initial.name,
        is_admin: props.initial.is_admin,
        rpm_limit: props.initial.rpm_limit,
        monthly_token_limit: props.initial.monthly_token_limit,
        lifetime_token_limit: props.initial.lifetime_token_limit,
      })
    } else {
      setValues({
        name: "",
        is_admin: false,
        rpm_limit: null,
        monthly_token_limit: null,
        lifetime_token_limit: null,
      })
    }
  }, [props.open, props.initial])

  if (!props.open) return null

  function nullableInt(s: string): number | null {
    if (s.trim() === "") return null
    const n = Number.parseInt(s, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>
          {props.initial ? "Edit token" : "New token"}
        </h3>
        <div className="field">
          <label>Name</label>
          <input
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
          />
        </div>
        {props.canEditAdminFlag && (
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={values.is_admin}
                onChange={(e) =>
                  setValues({ ...values, is_admin: e.target.checked })
                }
              />{" "}
              Admin
            </label>
          </div>
        )}
        <div className="field">
          <label>RPM limit (blank = unlimited)</label>
          <input
            value={values.rpm_limit ?? ""}
            onChange={(e) =>
              setValues({ ...values, rpm_limit: nullableInt(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>Monthly token limit</label>
          <input
            value={values.monthly_token_limit ?? ""}
            onChange={(e) =>
              setValues({
                ...values,
                monthly_token_limit: nullableInt(e.target.value),
              })
            }
          />
        </div>
        <div className="field">
          <label>Lifetime token limit</label>
          <input
            value={values.lifetime_token_limit ?? ""}
            onChange={(e) =>
              setValues({
                ...values,
                lifetime_token_limit: nullableInt(e.target.value),
              })
            }
          />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!values.name.trim()}
            onClick={() => props.onSubmit(values)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ConfirmDialog.tsx frontend/src/components/TokenFormDialog.tsx
git commit -m "feat(frontend): token form + confirm dialogs"
```

---

### Task 32: Tokens page

**Files:**
- Create: `frontend/src/pages/Tokens.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useState } from "react"

import { api } from "../api/client"
import { ConfirmDialog } from "../components/ConfirmDialog"
import {
  TokenFormDialog,
  type TokenFormValues,
} from "../components/TokenFormDialog"
import { useAuth } from "../contexts/AuthContext"
import type { CreatedToken, TokenRow } from "../types"

function fmtDate(ms: number | null): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString()
}

export function Tokens() {
  const { me } = useAuth()
  const [rows, setRows] = useState<Array<TokenRow>>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<TokenRow | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    onConfirm: () => void
    destructive?: boolean
  } | null>(null)
  const [createdReveal, setCreatedReveal] = useState<CreatedToken | null>(null)

  async function load() {
    try {
      setRows(await api.listTokens())
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  if (!me) return null
  const isSuper = me.role === "super"

  async function onCreate(values: TokenFormValues) {
    try {
      const created = await api.createToken({
        name: values.name,
        is_admin: values.is_admin,
        rpm_limit: values.rpm_limit,
        monthly_token_limit: values.monthly_token_limit,
        lifetime_token_limit: values.lifetime_token_limit,
      })
      setCreating(false)
      setCreatedReveal(created)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onEdit(values: TokenFormValues) {
    if (!editing) return
    try {
      await api.patchToken(editing.id, {
        name: values.name,
        rpm_limit: values.rpm_limit,
        monthly_token_limit: values.monthly_token_limit,
        lifetime_token_limit: values.lifetime_token_limit,
        ...(isSuper ? { is_admin: values.is_admin } : {}),
      } as Partial<TokenRow>)
      setEditing(undefined)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function ask(
    title: string,
    body: string,
    fn: () => Promise<void>,
    destructive = false,
  ) {
    setConfirm({
      title,
      body,
      destructive,
      onConfirm: async () => {
        setConfirm(null)
        try {
          await fn()
          await load()
        } catch (e) {
          setError((e as Error).message)
        }
      },
    })
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ flex: 1, margin: 0 }}>Tokens</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + New token
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Role</th>
            <th>RPM</th>
            <th>Monthly limit</th>
            <th>Lifetime used / limit</th>
            <th>Last used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const canEdit = isSuper || !r.is_admin
            return (
              <tr key={r.id}>
                <td>
                  {r.name}
                  {r.is_disabled && (
                    <span className="error"> (disabled)</span>
                  )}
                </td>
                <td><code>{r.token_prefix}</code></td>
                <td>{r.is_admin ? "admin" : "user"}</td>
                <td>{r.rpm_limit ?? "—"}</td>
                <td>{r.monthly_token_limit ?? "—"}</td>
                <td>
                  {r.lifetime_token_used.toLocaleString()} /{" "}
                  {r.lifetime_token_limit?.toLocaleString() ?? "—"}
                </td>
                <td>{fmtDate(r.last_used_at)}</td>
                <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {canEdit && (
                    <button onClick={() => setEditing(r)}>Edit</button>
                  )}
                  {canEdit && (
                    <button
                      onClick={() =>
                        ask(
                          "Reset monthly?",
                          `Reset monthly usage counter for "${r.name}"?`,
                          () => api.resetMonthly(r.id),
                        )
                      }
                    >
                      Reset monthly
                    </button>
                  )}
                  {isSuper && (
                    <button
                      onClick={() =>
                        ask(
                          "Reset lifetime?",
                          `Zero out lifetime usage for "${r.name}"?`,
                          () => api.resetLifetime(r.id),
                          true,
                        )
                      }
                    >
                      Reset lifetime
                    </button>
                  )}
                  {canEdit && (
                    <button
                      onClick={() =>
                        ask(
                          r.is_disabled ? "Enable?" : "Disable?",
                          `${r.is_disabled ? "Enable" : "Disable"} "${r.name}"?`,
                          () =>
                            api
                              .patchToken(r.id, {
                                is_disabled: !r.is_disabled,
                              } as Partial<TokenRow>)
                              .then(() => undefined),
                        )
                      }
                    >
                      {r.is_disabled ? "Enable" : "Disable"}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      className="danger"
                      onClick={() =>
                        ask(
                          "Delete token?",
                          `Permanently delete "${r.name}"? Active sessions for this token will be terminated.`,
                          () => api.deleteToken(r.id),
                          true,
                        )
                      }
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <TokenFormDialog
        open={creating}
        canEditAdminFlag={isSuper}
        onCancel={() => setCreating(false)}
        onSubmit={(v) => void onCreate(v)}
      />
      <TokenFormDialog
        open={editing !== undefined}
        initial={editing}
        canEditAdminFlag={isSuper}
        onCancel={() => setEditing(undefined)}
        onSubmit={(v) => void onEdit(v)}
      />
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          body={confirm.body}
          destructive={confirm.destructive}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}

      {createdReveal && (
        <div
          className="dialog-backdrop"
          onClick={() => setCreatedReveal(null)}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Token created</h3>
            <p>
              Copy the token now. <strong>It will never be shown again.</strong>
            </p>
            <pre
              style={{
                background: "var(--bg)",
                padding: 12,
                borderRadius: 6,
                wordBreak: "break-all",
                whiteSpace: "pre-wrap",
              }}
            >
              {createdReveal.token}
            </pre>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(createdReveal.token)
                }
              >
                Copy
              </button>
              <button
                className="primary"
                onClick={() => setCreatedReveal(null)}
              >
                I&apos;ve saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Tokens.tsx
git commit -m "feat(frontend): tokens management page"
```

---


## Phase 7 — Frontend: Usage page + Overview + Settings

### Task 33: TimeRangePicker + TrendChart + PerTokenTable components

**Files:**
- Create: `frontend/src/components/TimeRangePicker.tsx`
- Create: `frontend/src/components/TrendChart.tsx`
- Create: `frontend/src/components/PerTokenTable.tsx`

- [ ] **Step 1: `TimeRangePicker.tsx`**

```tsx
const PRESETS: Array<{ label: string; days: number | "today" }> = [
  { label: "Today", days: "today" },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
]

export interface Range {
  from: number
  to: number
  presetLabel: string
}

export function rangeFromPreset(p: { days: number | "today" }): Range {
  const now = Date.now()
  if (p.days === "today") {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return { from: d.getTime(), to: now, presetLabel: "Today" }
  }
  return {
    from: now - p.days * 86_400_000,
    to: now,
    presetLabel: `${p.days} days`,
  }
}

export function TimeRangePicker(props: {
  value: Range
  onChange: (r: Range) => void
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {PRESETS.map((p) => (
        <button
          key={p.label}
          className={p.label === props.value.presetLabel ? "primary" : ""}
          onClick={() => props.onChange(rangeFromPreset(p))}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: `TrendChart.tsx`**

```tsx
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { TimeseriesPoint } from "../types"

export function TrendChart(props: {
  data: Array<TimeseriesPoint>
  metric: "requests" | "tokens"
  stacked?: boolean
  tokenNames?: Record<number, string>
}) {
  if (!props.stacked) {
    const flat = props.data.map((d) => ({
      t: d.bucketStart,
      v: d[props.metric],
    }))
    return (
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={flat}>
          <CartesianGrid stroke="#2a2f3a" />
          <XAxis
            dataKey="t"
            tickFormatter={(v) => new Date(v).toLocaleDateString()}
            stroke="#8b93a7"
          />
          <YAxis stroke="#8b93a7" />
          <Tooltip
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            contentStyle={{ background: "#161a22", border: "1px solid #2a2f3a" }}
          />
          <Area dataKey="v" stroke="#4f8cff" fill="#4f8cff44" />
        </AreaChart>
      </ResponsiveContainer>
    )
  }
  // Stacked by token: pivot
  const tokenIds = Array.from(
    new Set(props.data.map((d) => d.authTokenId ?? 0)),
  )
  const buckets = Array.from(new Set(props.data.map((d) => d.bucketStart))).sort(
    (a, b) => a - b,
  )
  const rows = buckets.map((b) => {
    const row: Record<string, number> = { t: b }
    for (const id of tokenIds) {
      const match = props.data.find(
        (d) => d.bucketStart === b && (d.authTokenId ?? 0) === id,
      )
      row[`tok_${id}`] = match ? match[props.metric] : 0
    }
    return row
  })
  const palette = ["#4f8cff", "#ff8a4c", "#4caf50", "#c66cff", "#ffd54f"]
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={rows}>
        <CartesianGrid stroke="#2a2f3a" />
        <XAxis
          dataKey="t"
          tickFormatter={(v) => new Date(v).toLocaleDateString()}
          stroke="#8b93a7"
        />
        <YAxis stroke="#8b93a7" />
        <Tooltip
          labelFormatter={(v) => new Date(v as number).toLocaleString()}
          contentStyle={{ background: "#161a22", border: "1px solid #2a2f3a" }}
        />
        {tokenIds.map((id, i) => (
          <Area
            key={id}
            type="monotone"
            dataKey={`tok_${id}`}
            stackId="1"
            stroke={palette[i % palette.length]}
            fill={palette[i % palette.length] + "44"}
            name={props.tokenNames?.[id] ?? `token ${id}`}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}
```

- [ ] **Step 3: `PerTokenTable.tsx`**

```tsx
import type { PerTokenRow } from "../types"

function fmt(ms: number | null): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString()
}

export function PerTokenTable(props: { rows: Array<PerTokenRow> }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Token</th>
          <th>Requests</th>
          <th>Tokens</th>
          <th>Monthly %</th>
          <th>Last used</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td>{r.requests.toLocaleString()}</td>
            <td>{r.tokens.toLocaleString()}</td>
            <td>{r.monthly_pct === null ? "—" : `${r.monthly_pct}%`}</td>
            <td>{fmt(r.last_used_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/TimeRangePicker.tsx frontend/src/components/TrendChart.tsx frontend/src/components/PerTokenTable.tsx
git commit -m "feat(frontend): time range picker, trend chart, per-token table"
```

---

### Task 34: Usage page

**Files:**
- Create: `frontend/src/pages/Usage.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useMemo, useState } from "react"

import { api } from "../api/client"
import { PerTokenTable } from "../components/PerTokenTable"
import {
  rangeFromPreset,
  TimeRangePicker,
  type Range,
} from "../components/TimeRangePicker"
import { TrendChart } from "../components/TrendChart"
import { useAuth } from "../contexts/AuthContext"
import { suggestBucket } from "../lib/bucket"
import type {
  PerTokenRow,
  RecentLog,
  TimeseriesPoint,
  TokenRow,
} from "../types"

type Selection = "me" | "all" | number

export function Usage() {
  const { me } = useAuth()
  const [tokens, setTokens] = useState<Array<TokenRow>>([])
  const [selection, setSelection] = useState<Selection>("me")
  const [range, setRange] = useState<Range>(
    rangeFromPreset({ days: 7 }),
  )
  const [metric, setMetric] = useState<"requests" | "tokens">("requests")
  const [series, setSeries] = useState<Array<TimeseriesPoint>>([])
  const [perToken, setPerToken] = useState<Array<PerTokenRow>>([])
  const [recent, setRecent] = useState<Array<RecentLog>>([])
  const [error, setError] = useState<string | null>(null)

  const isAdmin = me?.role === "admin" || me?.role === "super"

  useEffect(() => {
    if (!isAdmin) return
    api.listTokens().then(setTokens).catch((e) => setError((e as Error).message))
  }, [isAdmin])

  const bucket = useMemo(
    () => suggestBucket(range.from, range.to),
    [range.from, range.to],
  )

  useEffect(() => {
    setError(null)
    api
      .timeseries({
        tokenId: selection,
        from: range.from,
        to: range.to,
        bucket,
      })
      .then(setSeries)
      .catch((e) => setError((e as Error).message))
    api
      .recent(selection)
      .then(setRecent)
      .catch((e) => setError((e as Error).message))
    if (isAdmin && selection === "all") {
      api
        .perToken(range.from, range.to)
        .then(setPerToken)
        .catch((e) => setError((e as Error).message))
    } else {
      setPerToken([])
    }
  }, [selection, range.from, range.to, bucket, isAdmin])

  const tokenNames = useMemo(() => {
    const map: Record<number, string> = {}
    for (const t of tokens) map[t.id] = t.name
    return map
  }, [tokens])

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ flex: 1, margin: 0 }}>Usage</h2>
        {isAdmin && (
          <select
            value={String(selection)}
            onChange={(e) => {
              const v = e.target.value
              setSelection(v === "me" || v === "all" ? v : Number.parseInt(v, 10))
            }}
          >
            <option value="me">Me</option>
            <option value="all">All tokens</option>
            {tokens.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <TimeRangePicker value={range} onChange={setRange} />
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as "requests" | "tokens")}
        >
          <option value="requests">Requests</option>
          <option value="tokens">Tokens</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <TrendChart
          data={series}
          metric={metric}
          stacked={selection === "all"}
          tokenNames={tokenNames}
        />
      </div>
      {selection === "all" && perToken.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3>Per-token</h3>
          <PerTokenTable rows={perToken} />
        </div>
      )}
      <h3>Recent requests</h3>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Endpoint</th>
            <th>Model</th>
            <th>Status</th>
            <th>Tokens</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.timestamp).toLocaleString()}</td>
              <td>{r.endpoint}</td>
              <td>{r.model ?? "—"}</td>
              <td>{r.statusCode}</td>
              <td>{r.totalTokens?.toLocaleString() ?? "—"}</td>
              <td>{r.latencyMs ? `${r.latencyMs}ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Usage.tsx
git commit -m "feat(frontend): usage page with chart, per-token, recent log"
```

---

### Task 35: Overview page

**Files:**
- Create: `frontend/src/pages/Overview.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useState } from "react"

import { api } from "../api/client"
import { useAuth } from "../contexts/AuthContext"
import type { UsageSummary } from "../types"

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  )
}

function pct(used: number, limit: number | null): string {
  if (!limit) return "—"
  return `${Math.min(100, Math.round((used / limit) * 100))}%`
}

export function Overview() {
  const { me } = useAuth()
  const [s, setS] = useState<UsageSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!me) return
    const tokenId =
      me.role === "super"
        ? "all"
        : me.role === "admin"
          ? "all"
          : "me"
    api.summary(tokenId).then(setS).catch((e) => setErr((e as Error).message))
  }, [me])

  if (!me) return null
  if (err) return <div className="error">{err}</div>
  if (!s) return <div>Loading…</div>

  return (
    <div>
      <h2>Overview</h2>
      <div className="cards">
        <Card label="Requests today" value={s.requests_today.toLocaleString()} />
        <Card label="Tokens today" value={s.tokens_today.toLocaleString()} />
        <Card
          label="Monthly used"
          value={`${s.monthly_used.toLocaleString()}${s.monthly_limit ? " / " + s.monthly_limit.toLocaleString() : ""}`}
        />
        <Card
          label="Monthly %"
          value={pct(s.monthly_used, s.monthly_limit)}
        />
        <Card
          label="Lifetime used"
          value={`${s.lifetime_used.toLocaleString()}${s.lifetime_limit ? " / " + s.lifetime_limit.toLocaleString() : ""}`}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Overview.tsx
git commit -m "feat(frontend): overview cards"
```

---

### Task 36: Settings page

**Files:**
- Create: `frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useState } from "react"

const TTL_KEY = "cpk_preferred_ttl"

export function Settings() {
  const [ttl, setTtl] = useState<number>(1)

  useEffect(() => {
    const v = window.localStorage.getItem(TTL_KEY)
    if (v) setTtl(Number.parseInt(v, 10))
  }, [])

  function update(next: number) {
    setTtl(next)
    window.localStorage.setItem(TTL_KEY, String(next))
  }

  return (
    <div>
      <h2>Settings</h2>
      <div className="card" style={{ maxWidth: 420 }}>
        <div className="field">
          <label>Default session duration</label>
          <select
            value={ttl}
            onChange={(e) => update(Number.parseInt(e.target.value, 10))}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
        <p className="label">
          Applied at next sign-in. Stored locally in this browser only.
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Settings.tsx
git commit -m "feat(frontend): settings page (session ttl preference)"
```

---


## Phase 8 — Build integration & end-to-end smoke

### Task 37: Root build scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add build:frontend, update build, add db:generate (if not yet)**

In `scripts`, ensure:

```json
"build:frontend": "cd frontend && bun install && bun run build",
"build": "bun run build:frontend && tsdown",
"db:generate": "drizzle-kit generate"
```

- [ ] **Step 2: Run a full build**

Run: `bun run build`
Expected: `dist/main.js` exists; `dist/public/index.html` and `dist/public/assets/` exist.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(build): add build:frontend and combined build"
```

---

### Task 38: End-to-end smoke

**Files:** none

- [ ] **Step 1: Start the server in one terminal**

Run: `bun run dev`
Expected: banner shows `📊 Dashboard: http://localhost:4141/?key=cpk-...`. Note the token.

- [ ] **Step 2: Open the dashboard**

In a browser, open `http://localhost:4141/?key=<super-admin-token>`. Expected:
- The URL `?key=` is replaced with `/` after a moment.
- Sidebar shows `super-admin / SUPER`.

- [ ] **Step 3: Create a regular token, copy it**

Tokens → + New token → name "smoke", save. Copy the revealed token.

- [ ] **Step 4: Hit a business API with the new token**

In another terminal:

```bash
curl -s http://localhost:4141/v1/models -H "Authorization: Bearer <smoke-token>" | head -c 200
```

Expected: 200 with a JSON body listing models.

- [ ] **Step 5: Verify usage is recorded**

Reload the dashboard → Overview / Usage. Expected: `requests_today >= 1`, the smoke token appears in Usage > All-tokens picker (admin/super) with a row in Recent.

- [ ] **Step 6: Verify limits enforce**

Edit smoke token, set RPM=1. Send two quick requests:

```bash
for i in 1 2; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4141/v1/models -H "Authorization: Bearer <smoke-token>"; done
```

Expected: first `200`, second `429`.

- [ ] **Step 7: Verify cookie session survives reload**

Reload the dashboard tab without `?key=`. Expected: still logged in.

- [ ] **Step 8: Verify session invalidates on token delete**

In another browser/private window, log in with a 2nd new token. From the super-admin tab, delete that token. Reload the second tab. Expected: kicked back to Login.

- [ ] **Step 9: Final lint + tests**

Run: `bun run typecheck && bun test && bun run lint .`
Expected: all green.

- [ ] **Step 10: Commit any final fixes**

If anything required tweaks during smoke:
```bash
git add -A
git commit -m "chore: smoke-test fixups"
```

---

## Self-Review Notes

Spec coverage check:
- §2 Roles → Tasks 12, 16, 17 (matrix enforced in middleware + route handlers)
- §4.1 `auth_tokens` → Tasks 2, 7
- §4.2 `request_logs` + retention → Tasks 2, 8, 13 (`maybePruneOldLogs`)
- §4.3 `sessions` + 1-hour cleanup → Tasks 2, 9, 23
- §4.4 `usage_resets` → Tasks 2, 8, 17
- §5.1 auth + usage middleware → Tasks 12, 13, 14, 15
- §5.2 admin endpoints + permission matrix → Tasks 16, 17, 18, 19
- §5.3 static SPA → Tasks 21, 22
- §5.4 logger redaction → Task 20
- §6 frontend layout/pages/build → Tasks 26–37
- §7 error codes → enforced in tasks 12 (rate_limit_exceeded / monthly_quota_exceeded / account_quota_exhausted) and 16/17/18 (auth_error/permission_denied)
- §8 security → constant-time compare (12), httpOnly cookie (16), 0600 chmod (4), redacted logger (20), single plaintext reveal (17)
- §10 CLI flags → Task 23
- §11 backward compat (`--no-auth` disables dashboard too) → Tasks 16 (`dashboardGate` checks `state.authEnabled`), 23 (default values)

No placeholders, every code block self-contained. Function/method names cross-checked between tasks.

