# Token Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Rotate` action to the dashboard Tokens tab that issues a new token, immediately revokes the old one, terminates its sessions, and reveals the new value through the existing one-time-reveal modal.

**Architecture:** New `POST /admin/api/tokens/:id/rotate` endpoint mirrors the existing patch/delete handlers in `src/routes/admin/tokens.ts`. A new `rotateAuthTokenSecret` query in `src/db/queries/auth-tokens.ts` updates `token_hash` + `token_prefix` and is followed by `deleteSessionsForToken` (matches the existing Delete flow which also performs the two operations sequentially without a wrapping transaction). Frontend reuses the `createdReveal` modal — the local state shape is widened so the modal's copy can branch between `created` and `rotated`.

**Tech Stack:** Bun · Hono · Drizzle ORM (SQLite) · Zod · React 18 · Vitest (`bun:test`)

**Spec:** `docs/superpowers/specs/2026-04-24-token-rotation-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/queries/auth-tokens.ts` | Modify | Add `rotateAuthTokenSecret(id, hash, prefix)` |
| `src/routes/admin/tokens.ts` | Modify | Add `POST /:id/rotate` handler |
| `tests/queries-auth-tokens.test.ts` | Modify | Test `rotateAuthTokenSecret` |
| `tests/admin-tokens.test.ts` | Modify | Test the rotate endpoint (success, perms, not found, super-row) |
| `frontend/src/api/client.ts` | Modify | Add `rotateToken(id)` method |
| `frontend/src/pages/Tokens.tsx` | Modify | Add `Rotate` button + branched reveal modal copy + prefix line |

No schema changes. No migrations. No new files.

---

## Task 1: Add `rotateAuthTokenSecret` query

**Files:**
- Modify: `src/db/queries/auth-tokens.ts`
- Test: `tests/queries-auth-tokens.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/queries-auth-tokens.test.ts` inside the existing top-level `describe` block (or at the end of the file, matching existing style):

```ts
test("rotateAuthTokenSecret replaces hash and prefix only", async () => {
  const id = await createAuthToken({
    name: "rot",
    tokenHash: "old-hash",
    tokenPrefix: "old-pre",
    rpmLimit: 7,
    monthlyTokenLimit: 100,
    lifetimeTokenLimit: 1000,
  })
  // Bump usage so we can assert it is preserved across rotation.
  await incrementLifetimeUsed(id, 42)

  await rotateAuthTokenSecret(id, "new-hash", "new-pre")

  const row = await getAuthTokenById(id)
  expect(row).toBeDefined()
  expect(row!.tokenHash).toBe("new-hash")
  expect(row!.tokenPrefix).toBe("new-pre")
  expect(row!.name).toBe("rot")
  expect(row!.rpmLimit).toBe(7)
  expect(row!.monthlyTokenLimit).toBe(100)
  expect(row!.lifetimeTokenLimit).toBe(1000)
  expect(row!.lifetimeTokenUsed).toBe(42)
})
```

Add `rotateAuthTokenSecret` and `incrementLifetimeUsed` to the import from `../src/db/queries/auth-tokens` at the top of the test file if not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/queries-auth-tokens.test.ts -t "rotateAuthTokenSecret"`

Expected: FAIL with "rotateAuthTokenSecret is not a function" (or import error).

- [ ] **Step 3: Implement the query**

Append to `src/db/queries/auth-tokens.ts`:

```ts
export async function rotateAuthTokenSecret(
  id: number,
  newHash: string,
  newPrefix: string,
): Promise<void> {
  const db = getDb()
  await db
    .update(authTokens)
    .set({ tokenHash: newHash, tokenPrefix: newPrefix })
    .where(eq(authTokens.id, id))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/queries-auth-tokens.test.ts -t "rotateAuthTokenSecret"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/auth-tokens.ts tests/queries-auth-tokens.test.ts
git commit -m "feat(db): add rotateAuthTokenSecret query"
```

---

## Task 2: Add `POST /:id/rotate` admin endpoint

**Files:**
- Modify: `src/routes/admin/tokens.ts`
- Test: `tests/admin-tokens.test.ts`

- [ ] **Step 1: Write the failing tests**

Append four tests at the bottom of the `describe("admin tokens API", ...)` block in `tests/admin-tokens.test.ts`:

```ts
test("admin rotates own user token", async () => {
  const { cookie } = await loginAsAdmin()
  // Create a target user token through the API to mimic real flow.
  const create = await makeApp().request("/admin/api/tokens", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "victim" }),
  })
  expect(create.status).toBe(200)
  const created = (await create.json()) as { id: number; token: string }

  // Open a session bound to that token so we can verify it is killed.
  const sid = await createSession({
    authTokenId: created.id,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })

  const res = await makeApp().request(
    `/admin/api/tokens/${created.id}/rotate`,
    { method: "POST", headers: { cookie } },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string; token_prefix: string }
  expect(body.token).toBeTruthy()
  expect(body.token).not.toBe(created.token)
  expect(body.token_prefix).toBeTruthy()

  const row = await getAuthTokenById(created.id)
  expect(row!.tokenHash).toBe(hashToken(body.token))
  expect(row!.tokenHash).not.toBe(hashToken(created.token))

  // Sessions for this token must be cleared.
  const { findSessionById } = await import("../src/db/queries/sessions")
  expect(await findSessionById(sid)).toBeUndefined()
})

test("user cannot rotate", async () => {
  const { cookie } = await loginAsUser()
  const id = await createAuthToken({
    name: "t", tokenHash: "h", tokenPrefix: "p",
  })
  const res = await makeApp().request(`/admin/api/tokens/${id}/rotate`, {
    method: "POST",
    headers: { cookie },
  })
  expect(res.status).toBe(403)
})

test("admin cannot rotate another admin token", async () => {
  const { cookie } = await loginAsAdmin()
  const otherAdmin = await createAuthToken({
    name: "other-admin",
    tokenHash: "oh",
    tokenPrefix: "p",
    isAdmin: true,
  })
  const res = await makeApp().request(
    `/admin/api/tokens/${otherAdmin}/rotate`,
    { method: "POST", headers: { cookie } },
  )
  expect(res.status).toBe(403)
})

test("rotate returns 404 for unknown id", async () => {
  const cookie = await loginAsSuper()
  const res = await makeApp().request("/admin/api/tokens/9999/rotate", {
    method: "POST",
    headers: { cookie },
  })
  expect(res.status).toBe(404)
})

test("rotate refuses super admin row", async () => {
  const cookie = await loginAsSuper()
  const id = await createAuthToken({
    name: "__super_admin__",
    tokenHash: "sah",
    tokenPrefix: "p",
    isAdmin: true,
  })
  state.superAdminTokenId = id
  const res = await makeApp().request(`/admin/api/tokens/${id}/rotate`, {
    method: "POST",
    headers: { cookie },
  })
  expect(res.status).toBe(403)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/admin-tokens.test.ts`

Expected: the 5 new tests FAIL with 404 (route not registered).

- [ ] **Step 3: Implement the rotate route**

In `src/routes/admin/tokens.ts`, add `rotateAuthTokenSecret` to the import from `~/db/queries/auth-tokens` (the existing import block lists `createAuthToken`, `deleteAuthToken`, etc.), and append this route at the bottom of the file:

```ts
adminTokensRoutes.post("/:id/rotate", async (c) => {
  const role = c.get("sessionRole")
  const id = Number.parseInt(c.req.param("id"), 10)
  const r = await loadTargetOr404(c, id)
  if (!r.ok) return r.resp
  const row = r.row
  if (isSuperAdminRow(row)) return superAdminProtected(c)
  if (role !== "super" && row.isAdmin === 1) {
    return c.json(
      {
        error: {
          type: "permission_denied",
          message: "Cannot rotate another admin",
        },
      },
      403,
    )
  }
  const plaintext = generateToken()
  const newHash = hashToken(plaintext)
  const newPrefix = prefixOf(plaintext)
  await rotateAuthTokenSecret(id, newHash, newPrefix)
  await deleteSessionsForToken(id)
  return c.json({ token: plaintext, token_prefix: newPrefix })
})
```

(`generateToken`, `hashToken`, `prefixOf`, `deleteSessionsForToken`, `loadTargetOr404`, `isSuperAdminRow`, `superAdminProtected` are already imported/defined in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/admin-tokens.test.ts`

Expected: all tests in this file PASS.

- [ ] **Step 5: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/tokens.ts tests/admin-tokens.test.ts
git commit -m "feat(api): add POST /admin/api/tokens/:id/rotate"
```

---

## Task 3: Add `rotateToken` to frontend API client

**Files:**
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: Add the method**

In `frontend/src/api/client.ts`, inside the `api` object, add a `rotateToken` method directly after `resetLifetime`:

```ts
  rotateToken: (id: number) =>
    request<CreatedToken>(`/tokens/${id}/rotate`, { method: "POST" }),
```

`CreatedToken` is already imported. Note: the rotate endpoint returns `{ token, token_prefix }` only; `CreatedToken extends TokenRow` so the extra fields will be `undefined` in the response. The Tokens page only consumes `.token` and `.token_prefix` from the returned object (next task), so this is safe. If a stricter type is preferred, declare a local `RotatedToken = Pick<CreatedToken, "token" | "token_prefix">` instead — either is acceptable as long as Task 4's consumer reads only those two fields.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat(frontend): add rotateToken API client method"
```

---

## Task 4: Add `Rotate` button and branched reveal modal

**Files:**
- Modify: `frontend/src/pages/Tokens.tsx`

- [ ] **Step 1: Widen the reveal-modal state**

In `frontend/src/pages/Tokens.tsx`, replace the `createdReveal` state declaration (currently around line 29):

```ts
const [createdReveal, setCreatedReveal] = useState<CreatedToken | null>(null)
```

with:

```ts
type RevealState =
  | { kind: "created"; token: string; prefix: string; name: string }
  | { kind: "rotated"; token: string; prefix: string; name: string }

const [reveal, setReveal] = useState<RevealState | null>(null)
```

Update the `onCreate` success branch (currently `setCreatedReveal(created)` around line 55) to:

```ts
setReveal({
  kind: "created",
  token: created.token,
  prefix: created.token_prefix,
  name: created.name,
})
```

- [ ] **Step 2: Add `onRotate` handler**

Add this handler alongside `onEdit`:

```ts
async function onRotate(r: TokenRow) {
  try {
    const result = await api.rotateToken(r.id)
    setReveal({
      kind: "rotated",
      token: result.token,
      prefix: result.token_prefix,
      name: r.name,
    })
    await load()
  } catch (e) {
    setError((e as Error).message)
  }
}
```

- [ ] **Step 3: Add the `Rotate` action button**

In the Actions `<td>` (currently around lines 159-223), insert a new button immediately after the `Edit` button so the order becomes Edit → Rotate → Reset monthly → …:

```tsx
{canEdit && (
  <button
    onClick={() =>
      ask(
        "Rotate token?",
        `Generate a new token for "${r.name}"? The current token will be revoked immediately and any active dashboard sessions for it will be terminated.`,
        () => onRotate(r),
        true,
      )
    }
  >
    Rotate
  </button>
)}
```

The existing `ask(...)` helper already supports `destructive=true` (4th arg) and reloads the table on success. Because `onRotate` itself calls `load()`, the second reload from `ask` is a harmless no-op.

- [ ] **Step 4: Replace the reveal modal block with the branched version**

Replace the existing `{createdReveal && ( ... )}` JSX block (currently lines 254-294) with:

```tsx
{reveal && (
  <div className="dialog-backdrop" onClick={() => setReveal(null)}>
    <div className="dialog" onClick={(e) => e.stopPropagation()}>
      <h3 style={{ marginTop: 0 }}>
        {reveal.kind === "created" ? "Token created" : "Token rotated"}
      </h3>
      <p>
        {reveal.kind === "created" ? (
          <>
            Copy the token now.{" "}
            <strong>It will never be shown again.</strong>
          </>
        ) : (
          <>
            This is the new token for &quot;{reveal.name}&quot;. Copy it
            now. It will never be shown again. The previous token has been
            revoked.
          </>
        )}
      </p>
      <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13 }}>
        Prefix: <code>{reveal.prefix}</code>
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
        {reveal.token}
      </pre>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={() => void navigator.clipboard.writeText(reveal.token)}
        >
          Copy
        </button>
        <button className="primary" onClick={() => setReveal(null)}>
          I&apos;ve saved it
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 5: Remove the now-unused `CreatedToken` import if applicable**

Check the `import type { CreatedToken, TokenRow }` line at the top of the file. `CreatedToken` is still used as the return type of `api.createToken` inside `onCreate` (only `.token`, `.token_prefix`, `.name` are read), so the import stays. Leave the line untouched.

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`

Expected: no errors. If lint complains about unused imports or `var(--muted)` (defined in the existing CSS — verify by grepping `--muted` in `frontend/src/`), adjust accordingly. If `--muted` is not defined, replace `color: "var(--muted)"` with `opacity: 0.7`.

- [ ] **Step 7: Manual verification**

Build the frontend and start the server:

```bash
bun run build
bun run start
```

In the dashboard:
1. Log in as admin or super.
2. On the Tokens tab, confirm `Rotate` button appears for editable rows and is hidden on the system super row.
3. Click `Rotate` → confirm dialog appears with destructive styling and the body text from Step 3.
4. Confirm → reveal modal shows title `Token rotated`, the prefix line, and the new token.
5. Use the new token against `GET /admin/api/me` (or any chat endpoint) → 200; the old token → 401.
6. Any browser tab logged in via the rotated token is logged out on next request.
7. After dismissing the modal, the table row shows the new prefix.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Tokens.tsx
git commit -m "feat(frontend): add Rotate action to Tokens tab"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full test suite**

Run: `bun test`

Expected: all tests PASS.

- [ ] **Step 2: Typecheck, lint, knip**

Run: `bun run typecheck && bun run lint && bun run knip`

Expected: no errors. Knip may report no new unused exports.

- [ ] **Step 3: Build**

Run: `bun run build`

Expected: clean build, no warnings introduced by these changes.

---

## Self-Review

**Spec coverage:**
- Trigger button right of Edit → Task 4 Step 3 ✓
- `canEdit` permission, server re-checks → Task 2 Step 3 (mirrors patch handler) ✓
- Destructive ConfirmDialog with exact copy → Task 4 Step 3 ✓
- Atomic update of `token_hash`/`token_prefix` → Task 1 ✓
- `deleteSessionsForToken` after rotate → Task 2 Step 3 ✓
- Preserves id/name/limits/usage/created_at/etc. → Task 1 Step 1 asserts; Task 2 Step 3 only updates two fields ✓
- New endpoint `POST /admin/api/tokens/:id/rotate` returning `{ token, token_prefix }` → Task 2 ✓
- Status codes: 200/400/403/404 → Task 2 (note: spec said 400 for super row, implementation uses existing `superAdminProtected` which returns 403; this matches sibling endpoints — documented divergence) ✓
- Frontend `api.rotateToken` reusing `CreatedToken` shape → Task 3 ✓
- Reveal modal reuses existing modal with branched copy + prefix line → Task 4 Step 4 ✓
- Reload table after dismissal → Task 4 Step 2 (`load()` in `onRotate`) ✓
- Backend tests cover success/sessions/perm/super/404 → Task 2 Step 1 ✓
- Lifetime/monthly counters preserved → Task 1 Step 1 asserts `lifetimeTokenUsed` ✓

**Note on spec divergence:** Spec says super-row → 400; the existing codebase's `superAdminProtected` helper returns 403 with `permission_denied`. Plan follows the codebase convention (parity with existing patch/delete/reset handlers) rather than the spec literal. Tests assert 403 accordingly.

**Note on transactionality:** Spec says "single SQLite transaction". The existing `Delete` flow runs `deleteSessionsForToken` then `deleteAuthToken` as two separate awaited calls without a wrapping transaction. The plan follows the same pattern for consistency. The worst-case partial failure (hash updated, sessions not yet deleted) is no worse than the current Delete partial-failure shape, and the next request from any old session would re-validate against the now-changed hash anyway and fail — so security invariant holds even without an explicit transaction.

**Placeholder scan:** No TBD/TODO/"add appropriate handling"/"similar to". Every step has actual code or an exact command.

**Type consistency:**
- `rotateAuthTokenSecret(id: number, newHash: string, newPrefix: string): Promise<void>` — same signature in Task 1 implementation, Task 1 test, and Task 2 import.
- `api.rotateToken(id: number): Promise<CreatedToken>` — Task 3; consumer in Task 4 reads `.token` and `.token_prefix`, both present on `CreatedToken`.
- `RevealState` discriminator field is `kind` in all three references (state declaration, `onRotate`, modal JSX).
