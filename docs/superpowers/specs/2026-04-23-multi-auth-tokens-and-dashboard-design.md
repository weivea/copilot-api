# Multi Auth-Token Management & Dashboard — Design

**Date:** 2026-04-23
**Status:** Approved (pending spec review)
**Scope:** Outbound API authentication only. The GitHub/Copilot upstream token system (`github_token`, in-memory `copilotToken`, refresh timer) is **not** changed by this work.

---

## 1. Goals

Today the project authenticates external clients with a single auth token persisted at `~/.local/share/copilot-api/auth_token`. We want:

1. Multiple auth tokens, each independently identified, with usage metering and per-token limits.
2. The file-based token continues to exist and acts as a **super administrator**.
3. Other tokens live in SQLite and are managed via a web dashboard.
4. The web dashboard is reachable at `/?key=<auth-token>` and exposes per-token usage analytics, CRUD, and limits administration appropriate to the caller's role.

## 2. Roles

| Role | Source | Powers |
|---|---|---|
| **Super Admin** | The single token in `~/.local/share/copilot-api/auth_token` (existing mechanism, untouched) | All powers: CRUD any token, promote/demote admins, edit any limit, reset lifetime usage on any token. Has no usage limits and is **not** stored in SQLite. |
| **Admin** | A row in SQLite `auth_tokens` with `is_admin = 1` | View global dashboards. CRUD / edit / reset-monthly on **regular** tokens only. **Cannot** create, modify, delete, or promote/demote other admins. **Cannot** reset lifetime usage. |
| **User** | A row in SQLite `auth_tokens` with `is_admin = 0` | Log in, view only their own usage data, view (read-only) their own limits. Cannot list other tokens or change anything. |

The Super Admin's powers derive from possessing the file token; deleting the file regenerates a new one on next start (existing behavior).

## 3. High-level Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Bun process (single port, default 4141)                  │
│                                                          │
│ Hono server                                              │
│  ├─ Business routes  /chat/completions, /v1/messages, …  │
│  │     ↓ authMiddleware (upgraded)                       │
│  │     ↓ usageRecorder middleware (new)                  │
│  ├─ Admin API        /admin/api/*                        │
│  │     ↓ sessionMiddleware (new)                         │
│  └─ Static SPA       /  and  /assets/*  (new)            │
│                                                          │
│ SQLite (drizzle-orm + bun:sqlite)                        │
│  └─ ~/.local/share/copilot-api/copilot-api.db (default)  │
└──────────────────────────────────────────────────────────┘
```

Mounting order matters: business routes → admin API → static SPA fallback.

## 4. Data Model

SQLite file at `~/.local/share/copilot-api/copilot-api.db` (overridable via `--db-path`). Drizzle migrations under `drizzle/` are applied at startup via `migrate()`.

### 4.1 `auth_tokens`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | Internal primary key referenced by all FKs. |
| `name` | TEXT NOT NULL | Human-readable label (e.g. "alice's CLI"). Primary UI display. |
| `token_hash` | TEXT NOT NULL UNIQUE | `SHA-256(token)`; used for authentication lookups. |
| `token_prefix` | TEXT NOT NULL | E.g. `cpk-ab12...cd34` (first 8 + last 4). UI only. |
| `is_admin` | INTEGER NOT NULL DEFAULT 0 | 0 / 1. |
| `is_disabled` | INTEGER NOT NULL DEFAULT 0 | 0 / 1. Disabled tokens are rejected and their sessions are evicted. |
| `rpm_limit` | INTEGER | NULL = unlimited. Requests per rolling 60s. |
| `monthly_token_limit` | INTEGER | NULL = unlimited. |
| `lifetime_token_limit` | INTEGER | NULL = unlimited. |
| `lifetime_token_used` | INTEGER NOT NULL DEFAULT 0 | Updated transactionally per request. |
| `created_at` | INTEGER NOT NULL | unix ms |
| `created_by` | INTEGER | FK → `auth_tokens.id`. NULL when created by Super Admin. |
| `last_used_at` | INTEGER | unix ms |

Indexes: `token_hash` UNIQUE, `is_disabled`.

The Super Admin token is **not** stored in this table; it has independent identity, no limits, and no statistics.

### 4.2 `request_logs`

Detail-level table; default 90-day retention.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `auth_token_id` | INTEGER | FK → `auth_tokens.id`. NULL when the request was made by the Super Admin. |
| `timestamp` | INTEGER NOT NULL | unix ms |
| `endpoint` | TEXT NOT NULL | E.g. `/chat/completions`, `/v1/messages`. |
| `model` | TEXT | From request body when known. |
| `prompt_tokens` | INTEGER | From upstream response (after stream completes). |
| `completion_tokens` | INTEGER | Same. |
| `total_tokens` | INTEGER | Same. |
| `status_code` | INTEGER NOT NULL | 200 / 4xx / 5xx. |
| `latency_ms` | INTEGER | Request received → response complete. |

Indexes: `(auth_token_id, timestamp)` composite, `(timestamp)` single (used for retention).

Retention: on each insert there is a 1% probability of running `DELETE FROM request_logs WHERE timestamp < now() - retention_ms`. This avoids a separate scheduled job. The retention window is set by `--log-retention-days` (default 90).

### 4.3 `sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | 32-byte random hex (cookie value). |
| `auth_token_id` | INTEGER | FK → `auth_tokens.id`. NULL for Super Admin sessions. |
| `is_super_admin` | INTEGER NOT NULL DEFAULT 0 | Marker for Super Admin sessions (no DB row to FK into). |
| `expires_at` | INTEGER NOT NULL | unix ms |
| `created_at` | INTEGER NOT NULL | unix ms |

Index: `expires_at` (used for cleanup).

Each request validates: not expired AND associated token still exists and is not disabled (unless `is_super_admin = 1`). A background hourly timer runs `DELETE FROM sessions WHERE expires_at < now()`.

### 4.4 `usage_resets`

Records explicit "reset" events so monthly/lifetime calculations can ignore older history without losing detail rows.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `auth_token_id` | INTEGER NOT NULL | FK → `auth_tokens.id`. |
| `kind` | TEXT NOT NULL | `monthly` or `lifetime`. |
| `reset_at` | INTEGER NOT NULL | unix ms |

Index: `(auth_token_id, kind, reset_at)`.

Computing monthly usage: `SUM(total_tokens)` over `request_logs` where `timestamp >` the larger of (start of current calendar month) and (latest `monthly` reset for that token).

Lifetime resets are paired with `UPDATE auth_tokens SET lifetime_token_used = 0` and a `lifetime` row; the row is for audit only.

## 5. API Surface

### 5.1 Business API (auth upgrade)

Existing routes are unchanged: `/chat/completions`, `/v1/messages`, `/embeddings`, `/models`, etc.

**`authMiddleware` upgraded behavior:**
1. Extract token: `Authorization: Bearer <t>` or `x-api-key: <t>` (existing).
2. Compare against the file Super Admin token first. Match ⇒ allow, do **not** record usage.
3. Otherwise look up SQLite: `SELECT … FROM auth_tokens WHERE token_hash = SHA256(token)`.
4. On match, verify `is_disabled = 0`, then enforce limits in order:
   - **RPM**: count `request_logs` entries for this token in the last 60 seconds.
   - **Monthly**: `SUM(total_tokens)` since the latest of (calendar month start, latest monthly reset).
   - **Lifetime**: read `auth_tokens.lifetime_token_used`.
5. Any limit exceeded → return as specified in §7.
6. On success, set `c.set('authTokenId', id)` for downstream middleware/handlers.
7. Constant-time comparison continues to use `crypto.timingSafeEqual`.

**`usageRecorder` middleware (new, mounted after `authMiddleware`):**
- Wrap `await next()`. After the response is finalized, insert a `request_logs` row.
- For streaming responses, the SSE adapter (`stream-translation.ts` and analogous code paths) calls back with the final token counts after stream completion.
- In the same transaction: `UPDATE auth_tokens SET lifetime_token_used = lifetime_token_used + ?, last_used_at = ?`.
- Failed requests (4xx/5xx) are still logged with `status_code` set; `*_tokens` columns may be 0/NULL.
- Telemetry failures are warn-logged but never fail the business request (fail-open on telemetry).

### 5.2 Admin API (under `/admin/api`, all behind `sessionMiddleware`)

JSON in/out. Permission insufficient → 403. Session invalid → 401.

**Auth / session**
- `POST /admin/api/login` — body `{ key, ttl_days }` where `ttl_days ∈ {1, 7, 30}`. Validates `key` against the file token then SQLite hash; on success creates a session row, sets `cpk_session` cookie (httpOnly, SameSite=Lax, Secure when TLS is on, Path=/). Returns `{ role, name }`.
- `POST /admin/api/logout` — deletes session row, clears cookie.
- `GET /admin/api/me` — returns role and associated token info for the current session.

**Tokens (admin / super admin)**
- `GET /admin/api/tokens` — list all tokens. Hidden from non-admins.
- `POST /admin/api/tokens` — body `{ name, is_admin?, rpm_limit?, monthly_token_limit?, lifetime_token_limit? }`. Admins cannot set `is_admin = true`. Response includes the **plaintext token exactly once**.
- `PATCH /admin/api/tokens/:id` — modify name and/or limits and/or `is_disabled`. Admins cannot modify any field on another admin row.
- `DELETE /admin/api/tokens/:id` — delete a token. Admins cannot delete admin rows. Cascades `DELETE FROM sessions WHERE auth_token_id = ?` so any active session is immediately invalidated.
- `POST /admin/api/tokens/:id/reset-monthly` — append a `usage_resets` row with `kind='monthly'`.
- `POST /admin/api/tokens/:id/reset-lifetime` — Super Admin only. `UPDATE auth_tokens SET lifetime_token_used = 0` and append `usage_resets` row with `kind='lifetime'`.

**Usage / dashboard**
- `GET /admin/api/usage/summary?token_id=<id|all|me>` — returns `{ requests_today, tokens_today, monthly_used, monthly_limit, lifetime_used, lifetime_limit }`.
- `GET /admin/api/usage/timeseries?token_id=<id|all|me>&from=<ts>&to=<ts>&bucket=<hour|day|week|month>` — returns `[{ bucket_start, requests, tokens, by_token? }]`. Includes `by_token` only when `token_id=all` and the caller is admin.
- `GET /admin/api/usage/per-token?from=<ts>&to=<ts>` — admin global table. Returns one row per token: `{ id, name, requests, tokens, monthly_pct, last_used_at }`.
- `GET /admin/api/usage/recent?token_id=<id|me>&limit=50` — most recent request log entries.

**Permission matrix**

| Endpoint | Super Admin | Admin | User |
|---|---|---|---|
| Tokens CRUD on regular tokens | ✅ | ✅ | ❌ |
| Tokens CRUD on admin rows | ✅ | ❌ | ❌ |
| `reset-monthly` | ✅ | ✅ (regular only) | ❌ |
| `reset-lifetime` | ✅ | ❌ | ❌ |
| Usage with `token_id=all` / `per-token` | ✅ | ✅ | ❌ |
| Usage with `token_id=me` | ✅ | ✅ | ✅ |

### 5.3 Static SPA

- `GET /` and any unmatched non-API GET → serve `dist/public/index.html` (SPA fallback).
- `GET /assets/*` → serve from `dist/public/assets/*`.
- The previous `server.get("/", c => c.text("Server running"))` is replaced. Health check moves to `GET /healthz`.

### 5.4 Logger Hardening

Hono `logger()` prints full URLs including `?key=...`. We replace it (or wrap it) with a redacting logger that strips the `key` query parameter before formatting.

## 6. Frontend

### 6.1 Project Layout

```
copilot-api/
├─ src/                          # backend (existing)
├─ frontend/                     # NEW: React + Vite subproject
│  ├─ package.json               # isolated deps
│  ├─ vite.config.ts             # build.outDir = ../dist/public
│  ├─ index.html
│  └─ src/
│     ├─ main.tsx
│     ├─ App.tsx                 # router + AuthProvider
│     ├─ api/client.ts           # fetch wrapper, sends cookies
│     ├─ contexts/AuthContext.tsx
│     ├─ pages/
│     │  ├─ Login.tsx
│     │  ├─ Overview.tsx
│     │  ├─ Tokens.tsx           # admin only
│     │  ├─ Usage.tsx
│     │  └─ Settings.tsx
│     ├─ components/
│     │  ├─ Layout.tsx           # 200px sidebar + topbar
│     │  ├─ TimeRangePicker.tsx
│     │  ├─ TrendChart.tsx       # recharts
│     │  ├─ PerTokenTable.tsx
│     │  ├─ TokenFormDialog.tsx
│     │  └─ ConfirmDialog.tsx
│     └─ types.ts                # hand-maintained shared types
└─ dist/
   ├─ main.js                    # tsdown output
   └─ public/                    # vite output (shipped in npm package)
```

### 6.2 Build Integration

- Root `package.json` adds: `"build:frontend": "cd frontend && bun install && bun run build"`, and updates `"build"` to `"bun run build:frontend && tsdown"`.
- Vite `outDir` writes to `../dist/public` with `emptyOutDir: true`.
- Root `files: ["dist"]` already exists, so `bun publish` ships the SPA.
- `.gitignore`: add `dist/public` and `frontend/node_modules` and `.superpowers/`.
- Frontend has its own `bun.lock`.

### 6.3 Static Hosting

The backend mounts a static handler (Hono-compatible, e.g. `hono/serve-static` or a small custom handler over `Bun.file`). Order: business routes → admin API → static fallback. Unmatched GETs return `index.html` for SPA routing.

### 6.4 Key Page Behaviors

**Login (`/`)**
1. On mount, read `URL.searchParams.get('key')`.
2. If present: `POST /admin/api/login` with `{ key, ttl_days: localStorage.preferred_ttl ?? 1 }`.
3. Success: `history.replaceState(null, '', '/')` to remove the query, then route to `/overview`.
4. Failure: render an input so the user can paste a token to retry.
5. If no `key`: probe `GET /admin/api/me`; if a valid session exists, route straight into the dashboard.

**Layout** — fixed 200px sidebar with: current user name + role badge + token prefix at the top; `Overview / Tokens (admin only) / Usage / Settings` menu; `Logout` at the bottom.

**Tokens page (admin view)** — table with columns Name / Prefix / Role / RPM / Monthly limit / Lifetime used·limit / Last used / Actions. Actions: Edit, Reset monthly, Reset lifetime (super only), Disable, Delete. "+ New token" opens a form dialog; on submit the response includes the plaintext token, displayed once with a Copy button and an "I've saved it" acknowledgement before close.

**Usage page** — selectors at the top: Token (User sees only "Me"; Admin also sees "All" plus each token by name), TimeRangePicker (Today / 7d / 30d / 90d / Custom), Bucket switch (hour/day/week/month, auto-suggested from range). Below: trend chart (recharts AreaChart; stacked when Token=All). When Token=All, an additional Per-token ranking table appears. Bottom: most recent 50 requests.

**Settings** — "Default session duration" select (1 / 7 / 30 days) stored in `localStorage` for next login. No sensitive operations live here.

### 6.5 Frontend Dependencies

Minimal: `react`, `react-dom`, `react-router-dom`, `recharts`, `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react*`. No UI library; CSS hand-written (≈300 lines). Tailwind is **not** added to keep the dependency footprint small.

### 6.6 Frontend Testing

In-scope: unit tests for pure utilities (e.g. range → bucket inference). Out of scope: full E2E. Backend tests cover the auth, limit, and reset semantics end-to-end.

## 7. Error Handling

| Scenario | Response |
|---|---|
| Token not found in either source | `401 { error: { type: "auth_error", message: "Invalid auth token." } }` (existing copy) |
| Token disabled | `401` same body — do not disclose existence |
| RPM exceeded | `429 { error: { type: "rate_limit_exceeded", retry_after_ms } }` |
| Monthly token limit exceeded | `429 { error: { type: "monthly_quota_exceeded" } }` |
| Lifetime token limit exceeded | `403 { error: { type: "account_quota_exhausted" } }` |
| Session invalid / expired | `401` (frontend intercepts and routes to Login) |
| Permission insufficient | `403` |
| DB write failure during usage recording | Warn-log only; the business response is unaffected |

## 8. Security

- Token values are compared with `crypto.timingSafeEqual` and stored only as `SHA-256` hashes (existing file token unchanged on disk).
- Custom logger strips the `key` query parameter before writing to stdout.
- Session cookie: `httpOnly`, `SameSite=Lax`, `Secure` when TLS is on, `Path=/`.
- DB file is created with `chmod 0600` (matching existing token files).
- New token plaintext is returned exactly once at creation; no API ever returns it again.

## 9. Performance

- The composite index `(auth_token_id, timestamp)` keeps token+window aggregations close to `O(log n + result)`.
- RPM check uses a prepared statement with `LIMIT`; the 60-second window typically holds far fewer than 100 rows for any single token.
- Monthly aggregation runs on every authenticated request. If QPS becomes an issue, add an in-memory LRU cache of monthly counters; v1 ships without it.

## 10. CLI Changes (`src/start.ts`)

New flags:

| Flag | Default | Description |
|---|---|---|
| `--db-path <path>` | `~/.local/share/copilot-api/copilot-api.db` | SQLite file path. |
| `--log-retention-days <n>` | `90` | Retention window for `request_logs`. |
| `--no-dashboard` | `false` | Disables admin API and SPA. Business API remains operational. |

`runServer()` startup order gains: open SQLite + run migrations (after `ensurePaths()`); start the hourly session-cleanup timer (before `serve(...)`).

Banner addition: `📊 Dashboard: <url>/?key=<super-admin-token>` is printed only when `--show-token` is set or when the file token is freshly generated (consistent with existing token-display rules).

## 11. Backward Compatibility

- Existing clients (e.g. Claude Code) that pass the file Super Admin token continue to work without change.
- There is **no** migration of the file token into SQLite; Super Admin is intentionally file-resident only.
- `--no-auth` continues to disable all authentication. When `--no-auth` is in effect, `/admin/api/*` returns `503` and the SPA refuses to load — operating the dashboard without auth would be unsafe.
- New developers will need `bun install` (root) and the first build will trigger `bun install` inside `frontend/`.

## 12. Out of Scope

- Email or chat notifications (e.g. quota warnings).
- Multi-tenant / org / team hierarchies.
- Self-service token rotation or self-service token creation by users.
- Audit log for administrative actions beyond `request_logs` and `usage_resets`.
- Internationalization (English UI only).
- End-to-end browser tests.
- Migration of, or interaction with, GitHub Copilot's own usage endpoint. The existing `/usage` route is preserved untouched.
