# Token Rotation — Design

**Date:** 2026-04-24
**Status:** Approved, ready for implementation plan
**Scope:** Web dashboard `Tokens` tab + admin API

## Background

The dashboard's `Tokens` page stores auth tokens as one-way hashes (`auth_tokens.token_hash`). Only the prefix (`token_prefix`) is persisted in plaintext for UI identification. Consequently the full token is shown exactly once, in the `createdReveal` modal at creation time. Users who lose the original value have no way to recover it.

Adding a "view full token" feature would require either storing plaintext tokens or reversibly-encrypting them in the database — a regression of the current security posture. Instead, this spec introduces **token rotation**: an atomic operation that issues a new token, immediately revokes the old one, and surfaces the new value through the existing one-time-reveal flow.

## Goals

- Allow authorized users to atomically replace a token's secret value while preserving its identity (id, name, limits, usage counters).
- Maintain the existing security posture: only hashes stored at rest; plaintext exists only briefly in the response.
- Reuse existing UI primitives (`ConfirmDialog`, `createdReveal` modal) for consistency.

## Non-goals

- Resetting usage counters (`lifetime_token_used`, monthly counters). Rotation is "change the key", not "fresh account".
- Grace periods or multi-token-per-row support. Old token is revoked immediately.
- Plaintext or reversible storage of tokens.
- Audit log entries for rotation events (possible follow-up; out of scope here).

## Behavior

### Trigger

A new `Rotate` button in the `Tokens` table Actions column, placed immediately to the right of `Edit`.

### Permission

Reuse existing `canEdit` rule from `frontend/src/pages/Tokens.tsx`:

> Visible iff: row is not the system super row, **and** (current user is super, **or** target is not an admin token).

Server enforces the same rule independently; UI visibility is convenience only.

### Confirmation

Clicking `Rotate` opens the existing `ConfirmDialog` with `destructive=true`:

- **Title:** `Rotate token?`
- **Body:** `Generate a new token for "<name>"? The current token will be revoked immediately and any active dashboard sessions for it will be terminated.`

### Server-side atomic operation

On confirm, a single SQLite transaction performs:

1. Generate a new random token using the same generator/hasher used by the existing token-creation path.
2. `UPDATE auth_tokens SET token_hash = ?, token_prefix = ? WHERE id = ?`
3. `DELETE FROM sessions WHERE auth_token_id = ?`
4. Return `{ token: <plaintext>, token_prefix: <new prefix> }`.

Fields **not** modified: `id`, `name`, `is_admin`, `is_disabled`, `rpm_limit`, `monthly_token_limit`, `lifetime_token_limit`, `lifetime_token_used`, `created_at`, `created_by`, `last_used_at`.

If any step fails the transaction rolls back; the old token remains valid and the client receives an error.

### Reveal modal

Reuse the existing `createdReveal` modal in `Tokens.tsx`, with branching copy:

- **Title:** `Token rotated`
- **Lead paragraph:** `This is the new token for "<name>". Copy it now. It will never be shown again. The previous token has been revoked.`
- A small `Prefix: <new_prefix>` line is rendered above the `<pre>` block to help the user correlate the new value with its row.
- Buttons: existing `Copy` and `I've saved it`.

After the user dismisses the modal, the table is reloaded so the updated `token_prefix` is shown.

## API

**New endpoint:** `POST /admin/tokens/:id/rotate`

- **Auth:** existing admin auth middleware (`src/lib/auth-middleware.ts` chain used by `src/routes/admin/*`).
- **Authorization:** handler re-checks the `canEdit`-equivalent rule.
- **Responses:**
  - `200 { token: string, token_prefix: string }` — same shape as `CreatedToken`.
  - `400` — target is the system super row.
  - `403` — caller lacks permission for this row.
  - `404` — `:id` not found.
  - `500` — unexpected error, surfaced via `forwardError(c, error)`.

**Frontend client:** add `api.rotateToken(id: number): Promise<CreatedToken>` in `frontend/src/api/client.ts`. No new TypeScript type needed; reuses `CreatedToken`.

## Files affected

- `src/routes/admin/tokens.ts` — new `POST /:id/rotate` route + handler.
- `src/db/queries/...` (or inline if existing queries are not centralized for tokens) — new rotate query running inside a transaction.
- `src/lib/token.ts` (or wherever token generation/hashing lives) — reuse the existing helpers; no signature changes expected.
- `frontend/src/api/client.ts` — new `rotateToken` method.
- `frontend/src/pages/Tokens.tsx` — new `Rotate` action button; extend reveal-modal state to handle "created" vs "rotated" copy and to surface the prefix line.

No schema changes. No migrations.

## Error handling

- Server uses the project's `HTTPError` class and `forwardError(c, error)` pattern, consistent with sibling endpoints in `src/routes/admin/tokens.ts`.
- Client surfaces failures through the page's existing `setError` flow; the table is not reloaded on failure (old token still valid).

## Testing

Bun test runner, conventions per `tests/*.test.ts`.

**Backend:**

- `rotate` succeeds → `token_hash` differs from prior value; new plaintext authenticates; old plaintext fails to authenticate.
- `rotate` succeeds → all rows in `sessions` with `auth_token_id = id` are removed.
- `rotate` succeeds → `lifetime_token_used`, `name`, limits, `created_at`, `created_by`, `last_used_at` are unchanged.
- System super row → `400`.
- Non-super caller rotating an admin token → `403`.
- Unknown id → `404`.
- Transaction failure → no fields mutated, sessions intact (mock the session delete to throw, assert hash unchanged).

**Frontend:**

Manual verification, consistent with the rest of `frontend/` which currently has no React test harness:

1. Rotate visible per `canEdit` rules.
2. Confirm dialog appears with destructive styling.
3. Reveal modal shows new token + prefix line; Copy works.
4. Table reloads after dismissal; prefix is updated.
5. Old token receives 401 from a chat endpoint immediately after rotation.
6. A dashboard tab logged in via the rotated token is logged out on next request.

## Security & observability

- Storage shape unchanged: only hashes at rest.
- Plaintext exists only in the HTTP response body, mirroring the create flow.
- Old credential and its sessions are invalidated atomically — no residual trust.
- Future improvement (out of scope): write a rotation event to an audit log.

## Open questions

None. All decisions confirmed during brainstorming:

- Rotation = immediate revocation (no grace period).
- Permission = identical to existing `canEdit`.
- Button position = right of `Edit`.
- Destructive confirmation dialog = required.
- Sessions for the rotated token = deleted (parity with `Delete`).
- Reveal = reuse `createdReveal` modal with rotated-copy + new-prefix line.
