# Remove URL Key Auto-Login — Design

**Date:** 2026-04-24
**Status:** Approved, ready for implementation plan
**Scope:** CLI startup output (`src/start.ts`) + dashboard login page (`frontend/src/pages/Login.tsx`)

## Background

The CLI currently prints a dashboard URL with the super-admin token embedded in the query string:

```
📊 Dashboard: http://localhost:4141/?key=cpk-…
```

The frontend's `Login.tsx` reads `?key=…` from `window.location.href` on mount and silently calls `POST /admin/api/login`, then strips the parameter from the URL via `history.replaceState`. This is convenient but exposes the token in:

- Shell history when the URL is copy-pasted
- Browser history
- HTTP `Referer` header on any first cross-origin navigation
- Screen shares, screenshots, terminal recordings, support transcripts

The Login page already has a working manual form (paste token → Sign in). The auto-login path adds risk without unique value.

## Goals

- Eliminate the URL `?key=…` auto-login flow entirely.
- Keep CLI startup useful: print the dashboard URL and, when appropriate, the super-admin token — but never together in a copy-pasteable URL.
- Preserve the existing manual login form unchanged.

## Non-goals

- One-shot magic links / time-limited tokens.
- Token masking in the terminal (the user must paste the full token; masking adds friction without security benefit since the value is already on screen).
- Changes to `setupAuthToken()`'s "first-generation only" token-printing rule.

## Behavior

### CLI startup output

Replace the single line at `src/start.ts:147`:

```ts
`📊 Dashboard: ${serverUrl}/?key=${state.superAdminToken ?? "<your-token>"}`
```

with a multi-line block following the agreed Format B:

```
✔ Dashboard ready
  URL:   http://localhost:4141/
  Token: <see the "Super admin token" line above, or rerun with --show-token>
  Open the URL, then paste the token into the login form.
```

When auth is disabled, render:

```
✔ Dashboard ready
  URL:   http://localhost:4141/
  Auth: disabled
```

Implementation note: use `consola.box` if the rest of the file already uses it for similar grouped output; otherwise use 3-4 successive `consola.info` calls. Match the existing style in `src/start.ts`.

The super-admin token itself is **not** added to this block. It is already printed (once) by `setupAuthToken()` on first generation, or on any startup when `--show-token` is set. That gating is correct and stays.

### Frontend login page

In `frontend/src/pages/Login.tsx`:

1. **Delete** the `useEffect` block (lines 16-34) that reads `url.searchParams.get("key")` and auto-logs-in.
2. Remove now-unused imports: `useEffect` (only used by that effect), `useNavigate` (only used by that effect — confirm by reading the rest of the file; the manual `submit` handler also uses `nav`, so `useNavigate` stays).

Actually, re-checking: `nav` is used by both the deleted effect and `submit`. So `useNavigate` import stays. Only `useEffect` becomes unused if no other effect remains. Verify and prune accordingly during implementation.

The form (lines 55-86) stays as-is.

### Backwards compatibility

A user who still has a bookmarked `http://localhost:4141/?key=…` URL will see:

- The query parameter is silently ignored (no auto-login, no redirect, no error toast).
- The standard Login form renders.
- They paste the token and continue.

No active deprecation message. Cleaner than a temporary warning that someone has to remember to remove later.

## Files affected

- `src/start.ts` — replace the dashboard-URL print line.
- `frontend/src/pages/Login.tsx` — remove the URL-key effect and any now-unused imports.

No schema changes. No backend logic changes. No new tests required (the change is the *removal* of an insecure pathway; the existing `POST /admin/api/login` tests still cover the manual form's call site).

## Testing

Manual verification, consistent with the rest of `frontend/`:

1. Start the server: `bun run start`. Confirm the new format prints. Confirm the previous `?key=` URL line is gone.
2. Open `http://localhost:4141/` in a fresh browser profile. Confirm the Login form renders.
3. Open `http://localhost:4141/?key=anything` in a fresh browser profile. Confirm the form still renders, no auto-login, no network call to `/admin/api/login` until the user clicks Sign in.
4. Paste the super-admin token into the form, click Sign in. Confirm normal login flow works and the user lands on `/overview`.
5. Restart the server with `--show-token` (or whatever flag triggers it). Confirm the super-admin token is printed once by `setupAuthToken()`, separately from the dashboard-ready block.

## Documentation

If `README.md` references `?key=…` URLs in screenshots, examples, or instructions, update those references to describe the manual-paste flow instead. Do this in the same commit as the code change.

## Open questions

None. Implementation is small enough that any remaining ambiguity can be resolved by reading the current `src/start.ts` immediately around line 147 to match the surrounding style.
