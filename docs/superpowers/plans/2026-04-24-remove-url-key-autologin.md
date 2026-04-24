# Remove URL Key Auto-Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the dashboard's URL `?key=<token>` auto-login pathway and replace the CLI's combined-URL startup banner with a separate URL + login-instruction block.

**Architecture:** Two surgical edits — one CLI startup banner change in `src/start.ts`, one effect deletion in `frontend/src/pages/Login.tsx`. The existing manual login form and the `setupAuthToken()` first-generation token-print remain unchanged.

**Tech Stack:** Bun · Hono · React 18 · `consola` for terminal output · `bun:test`

**Spec:** `docs/superpowers/specs/2026-04-24-remove-url-key-autologin-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/start.ts` | Modify (lines 145-149) | Replace single `?key=` URL line with multi-line URL + instruction block |
| `frontend/src/pages/Login.tsx` | Modify | Remove `useEffect` that reads `?key=` and auto-logs-in; prune unused imports |

No new files. No schema changes. No test files (existing `POST /admin/api/login` tests still cover the manual form's call site; UI verification is manual per project convention).

---

## Task 1: Replace startup banner in `src/start.ts`

**Files:**
- Modify: `src/start.ts:145-149`

- [ ] **Step 1: Apply the edit**

Replace the existing block:

```ts
  if (state.dashboardEnabled) {
    consola.box(
      `📊 Dashboard: ${serverUrl}/?key=${state.superAdminToken ?? "<your-token>"}`,
    )
  }
```

with:

```ts
  if (state.dashboardEnabled) {
    const lines = state.authEnabled
      ? [
          "📊 Dashboard ready",
          `  URL:   ${serverUrl}/`,
          `  Token: see the "Super admin token" line above, or rerun with --show-token`,
          "  Open the URL, then paste the token into the login form.",
        ]
      : [
          "📊 Dashboard ready",
          `  URL:   ${serverUrl}/`,
          "  Auth: disabled",
        ]
    consola.box(lines.join("\n"))
  }
```

Notes:
- `state.authEnabled` is already referenced elsewhere (e.g., in `src/lib/auth-token.ts:34`); no new import needed.
- `consola.box` is already used at the original location; same import.
- The super-admin token itself is intentionally NOT included here. `setupAuthToken()` (in `src/lib/auth-token.ts:78-80`) already prints it on first generation or when `--show-token` is set.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Lint**

Run: `bun run lint 2>&1 | grep "src/start.ts" -A 5`
Expected: no NEW errors at lines 145-149 (pre-existing errors elsewhere are out of scope).

- [ ] **Step 4: Smoke-run the server**

Run (in one terminal): `bun run start --port 4242 2>&1 | head -30`
Expected: the new "Dashboard ready" block appears with `URL:   http://localhost:4242/` (no `?key=` substring anywhere). The server can be killed (Ctrl-C) immediately after the banner appears.

Verify with: `bun run start --port 4242 2>&1 | head -30 | grep -c '?key='`
Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add src/start.ts
git commit -m "feat(cli): drop ?key= from dashboard startup banner

Print the URL and login instructions on separate lines instead of
a copy-pasteable URL containing the super-admin token. The token
is still printed once by setupAuthToken() on first generation or
when --show-token is set."
```

---

## Task 2: Remove URL-key auto-login effect in `Login.tsx`

**Files:**
- Modify: `frontend/src/pages/Login.tsx`

- [ ] **Step 1: Apply the edit**

Use the Edit tool with this exact replacement.

old_string (lines 1-2 + the effect block; produced verbatim from the current file):

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
    const url = new URL(globalThis.location.href)
    const key = url.searchParams.get("key")
    if (!key) return
    const ttl = Number.parseInt(
      globalThis.localStorage.getItem(TTL_KEY) ?? "1",
      10,
    )
    setBusy(true)
    api
      .login(key, [1, 30, 7].includes(ttl) ? ttl : 1)
      .then(async () => {
        globalThis.history.replaceState(null, "", "/")
        await refresh()
        nav("/overview", { replace: true })
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }, [])
```

new_string:

```tsx
import { useState } from "react"
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
```

This both removes the effect block and prunes the now-unused `useEffect` import. `useNavigate`, `api`, and `useAuth` remain — they are used by the manual `submit` handler immediately below.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Lint**

Run: `bun run lint 2>&1 | grep "Login.tsx" -A 5`
Expected: no NEW errors. (If `unused-imports` flags anything that was missed, remove it and re-run.)

- [ ] **Step 4: Build the frontend**

Run: `bun run build`
Expected: clean build.

- [ ] **Step 5: Manual browser verification**

(Run the server from the worktree: `bun run start --port 4242`.)

1. Open `http://localhost:4242/` in a fresh browser window. Confirm the Login form renders with no auto-login attempt (Network tab: no POST to `/admin/api/login` until you click Sign in).
2. Open `http://localhost:4242/?key=anything-here`. Confirm the form still renders, no auto-login, no redirect, no error toast.
3. Paste the super-admin token (printed by `setupAuthToken()` on first start, or visible via `--show-token`) into the form and click Sign in. Confirm normal login → `/overview`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Login.tsx
git commit -m "feat(frontend): remove URL ?key= auto-login

The dashboard no longer auto-logs-in from the query string. Users
paste the super-admin token into the existing Login form. Removes
the security exposure of having tokens in shell history, browser
history, and HTTP Referer headers."
```

---

## Task 3: Update README references (if any)

**Files:**
- Modify: `README.md` (only if it mentions `?key=` URLs)

- [ ] **Step 1: Search for `?key=` references in docs**

Run: `grep -nF "?key=" README.md docs/ 2>&1 | grep -v "/superpowers/"`

If the output is empty, mark this task complete and skip to commit step (no edit needed).

If the output shows references in `README.md` (or other non-spec/plan docs), open each and update the prose:
- Replace any URL containing `?key=...` with the bare URL.
- Wherever the doc said "open this URL to sign in", append: "then paste the super-admin token into the login form".

- [ ] **Step 2: Commit (skip if no changes)**

If files were modified:

```bash
git add README.md
git commit -m "docs: drop ?key= URL pattern from README"
```

If nothing changed, no commit. Move on.

---

## Task 4: Final verification

- [ ] **Step 1: Test suite**

Run: `bun test`
Expected: all tests pass (unchanged from before — this work is removal-only).

- [ ] **Step 2: Typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: clean.

- [ ] **Step 3: Confirm no `?key=` left in non-spec docs/code**

Run: `grep -rnF "?key=" src/ frontend/src/ README.md 2>&1`
Expected: no matches (the spec/plan files in `docs/superpowers/` may still mention `?key=` for historical context — that's fine; the grep above excludes them).

---

## Self-Review

**Spec coverage:**
- Replace `src/start.ts:147` with multi-line block (Format B) → Task 1 ✓
- Auth-disabled path renders different lines → Task 1 (the `state.authEnabled ? […] : […]` ternary) ✓
- Token NOT included in startup block → Task 1 (intentionally omitted; spec note included) ✓
- Delete `useEffect` block in `Login.tsx` → Task 2 ✓
- Prune unused `useEffect` import; keep `useNavigate` (used by `submit`) → Task 2 (handled in the same Edit) ✓
- Bookmarked `?key=…` URL: silently ignored, form still renders → Task 2 Step 5 (manual verification 2) ✓
- Form unchanged → Task 2's Edit only touches lines 1-34, leaves 35+ alone ✓
- README updates if applicable → Task 3 ✓

**Placeholder scan:** No "TBD" / "implement later" / vague descriptions. Every code-changing step shows the exact code. Every command has expected output.

**Type consistency:** No new types or signatures introduced. The state field referenced (`state.authEnabled`) is already used elsewhere in the codebase.
