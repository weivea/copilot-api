# TLS Certificate Expiry Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let super-admins view the configured TLS certificate's expiration (and metadata) from the Settings page in the web UI.

**Architecture:** Add a super-admin-only `GET /admin/api/certificate` endpoint backed by a pure helper that reads the configured PEM file via `node:crypto`'s `X509Certificate`. The frontend's existing `Settings` page renders a new `<TlsCertificateCard />` (super-admin only) that calls the endpoint and renders three branches — not configured / read failed / success — with traffic-light coloring on days remaining.

**Tech Stack:** Bun, Hono, TypeScript, `node:crypto`, React, Tailwind, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-04-28-tls-cert-expiry-card-design.md`

---

## File Structure

**New backend files**

- `src/lib/certificate.ts` — pure async function `readCertificateInfo()` returning a discriminated union (`not_configured | read_error | success`). No Hono concerns here.
- `src/routes/admin/certificate.ts` — small Hono router that mounts `sessionMiddleware({ requireRole: "super" })` and exposes `GET /`.
- `tests/admin-certificate.test.ts` — Bun tests covering the helper (3 branches) and the route (super 200 / admin 403 / unauthenticated 401).
- `tests/helpers/cert-fixture.ts` — reusable utility to write a self-signed PEM into a temp dir for tests.

**New frontend files**

- `frontend/src/components/TlsCertificateCard.tsx` — renders the card; calls `api.getCertificate()`; branches by union; shows refresh button.

**Modified backend files**

- `src/routes/admin/route.ts` — add `adminRoutes.route("/certificate", adminCertificateRoutes)`.

**Modified frontend files**

- `frontend/src/types.ts` — add `CertificateInfo` discriminated union.
- `frontend/src/api/client.ts` — add `getCertificate()`.
- `frontend/src/pages/Settings.tsx` — fetch `me`, render `<TlsCertificateCard />` only when `me.role === "super"`.

---

## Task 1: Backend helper — `readCertificateInfo`

**Files:**
- Create: `src/lib/certificate.ts`
- Create: `tests/helpers/cert-fixture.ts`
- Create: `tests/certificate-lib.test.ts`

- [ ] **Step 1: Write the test fixture helper**

Create `tests/helpers/cert-fixture.ts`:

```ts
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface FixtureCert {
  dir: string
  certPath: string
  keyPath: string
}

/**
 * Writes a self-signed cert + key into a fresh temp dir using `openssl`.
 * Tests that need a custom validity window pass `daysValid` (negative = expired).
 */
export function makeSelfSignedCert(
  domain = "example.test",
  daysValid = 90,
): FixtureCert {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpk-cert-"))
  const certPath = path.join(dir, "fullchain.pem")
  const keyPath = path.join(dir, "privkey.pem")
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${domain}`,
      "-days",
      String(daysValid),
    ],
    { stdio: "ignore" },
  )
  return { dir, certPath, keyPath }
}

export function cleanupFixture(f: FixtureCert): void {
  fs.rmSync(f.dir, { recursive: true, force: true })
}
```

- [ ] **Step 2: Write the failing helper tests**

Create `tests/certificate-lib.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { readCertificateInfo } from "../src/lib/certificate"
import { PATHS } from "../src/lib/paths"
import {
  cleanupFixture,
  makeSelfSignedCert,
  type FixtureCert,
} from "./helpers/cert-fixture"

let originalConfigPath: string
let tmpHome: string
let fixture: FixtureCert | null = null

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cpk-home-"))
  originalConfigPath = PATHS.CONFIG_PATH
  // Point loadConfig at a temp file by overriding PATHS.CONFIG_PATH
  ;(PATHS as { CONFIG_PATH: string }).CONFIG_PATH = path.join(
    tmpHome,
    "copilot-api.config.json",
  )
})

afterEach(async () => {
  ;(PATHS as { CONFIG_PATH: string }).CONFIG_PATH = originalConfigPath
  await fs.rm(tmpHome, { recursive: true, force: true })
  if (fixture) {
    cleanupFixture(fixture)
    fixture = null
  }
})

async function writeConfig(obj: unknown): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify(obj))
}

describe("readCertificateInfo", () => {
  test("returns not_configured when config has no tls", async () => {
    await writeConfig({})
    const info = await readCertificateInfo()
    expect(info.configured).toBe(false)
    if (!info.configured) {
      expect(info.reason).toBe("not_configured")
      expect(info.hint).toContain("./scripts/cert.sh obtain")
    }
  })

  test("returns error branch when cert file missing", async () => {
    const missing = path.join(tmpHome, "nope.pem")
    await writeConfig({
      tls: { cert: missing, key: path.join(tmpHome, "k.pem") },
    })
    const info = await readCertificateInfo()
    expect(info.configured).toBe(true)
    if (info.configured && "error" in info) {
      expect(info.error).toContain("ENOENT")
      expect(info.certPath).toBe(missing)
    } else {
      throw new Error("expected error branch")
    }
  })

  test("parses a valid PEM and computes daysRemaining", async () => {
    fixture = makeSelfSignedCert("plan.test", 30)
    await writeConfig({
      domain: "plan.test",
      tls: { cert: fixture.certPath, key: fixture.keyPath },
    })
    const info = await readCertificateInfo()
    expect(info.configured).toBe(true)
    if (info.configured && "subject" in info) {
      expect(info.subject).toContain("plan.test")
      expect(info.issuer).toContain("plan.test") // self-signed
      expect(info.domain).toBe("plan.test")
      expect(info.expired).toBe(false)
      expect(info.daysRemaining).toBeGreaterThan(28)
      expect(info.daysRemaining).toBeLessThanOrEqual(30)
      expect(new Date(info.validTo).getTime()).toBeGreaterThan(Date.now())
    } else {
      throw new Error("expected success branch")
    }
  })

  test("flags expired cert", async () => {
    // openssl rejects negative days; use 1-day cert and back-date check
    // by constructing an already-expired cert via -days 0 fallback:
    // simplest: create a cert with -days 1 and override Date.now via offset
    fixture = makeSelfSignedCert("old.test", 1)
    await writeConfig({
      tls: { cert: fixture.certPath, key: fixture.keyPath },
    })
    const realNow = Date.now
    Date.now = () => realNow() + 5 * 86_400_000 // 5 days in the future
    try {
      const info = await readCertificateInfo()
      if (info.configured && "expired" in info) {
        expect(info.expired).toBe(true)
        expect(info.daysRemaining).toBeLessThan(0)
      } else {
        throw new Error("expected success branch with expired=true")
      }
    } finally {
      Date.now = realNow
    }
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/certificate-lib.test.ts`
Expected: FAIL with `Cannot find module '../src/lib/certificate'`.

- [ ] **Step 4: Implement the helper**

Create `src/lib/certificate.ts`:

```ts
import { X509Certificate } from "node:crypto"
import fs from "node:fs/promises"

import { loadConfig } from "./config"

export type CertificateInfo =
  | {
      configured: false
      reason: "not_configured"
      hint: string
    }
  | {
      configured: true
      error: string
      certPath: string
    }
  | {
      configured: true
      domain: string | null
      subject: string
      issuer: string
      validFrom: string
      validTo: string
      daysRemaining: number
      expired: boolean
      certPath: string
    }

const NOT_CONFIGURED_HINT =
  "Run ./scripts/cert.sh obtain --domain <your-domain> to obtain a certificate."

export async function readCertificateInfo(): Promise<CertificateInfo> {
  const config = await loadConfig()
  const certPath = config.tls?.cert
  if (!certPath) {
    return {
      configured: false,
      reason: "not_configured",
      hint: NOT_CONFIGURED_HINT,
    }
  }
  try {
    const pem = await fs.readFile(certPath)
    const cert = new X509Certificate(pem)
    const validFrom = new Date(cert.validFrom)
    const validTo = new Date(cert.validTo)
    const now = Date.now()
    const daysRemaining = Math.floor(
      (validTo.getTime() - now) / 86_400_000,
    )
    return {
      configured: true,
      domain: config.domain ?? null,
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysRemaining,
      expired: daysRemaining < 0,
      certPath,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error)
    return { configured: true, error: message, certPath }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/certificate-lib.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/certificate.ts tests/certificate-lib.test.ts tests/helpers/cert-fixture.ts
git commit -m "feat(certificate): add readCertificateInfo helper"
```

---

## Task 2: Backend route — `GET /admin/api/certificate`

**Files:**
- Create: `src/routes/admin/certificate.ts`
- Modify: `src/routes/admin/route.ts`
- Create: `tests/admin-certificate.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `tests/admin-certificate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { Hono } from "hono"
import os from "node:os"
import path from "node:path"

import { hashToken } from "../src/lib/auth-token-utils"
import { PATHS } from "../src/lib/paths"
import { state } from "../src/lib/state"
import { adminAuthRoutes } from "../src/routes/admin/auth"
import { adminCertificateRoutes } from "../src/routes/admin/certificate"
import {
  cleanupFixture,
  makeSelfSignedCert,
  type FixtureCert,
} from "./helpers/cert-fixture"
import { makeTestDb } from "./helpers/test-db"

const SUPER =
  "cpk-super000000000000000000000000000000000000000000000000000000000000"
const ADMIN =
  "cpk-admin000000000000000000000000000000000000000000000000000000000000"

let originalConfigPath: string
let tmpHome: string
let fixture: FixtureCert | null = null

beforeEach(async () => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cpk-home-"))
  originalConfigPath = PATHS.CONFIG_PATH
  ;(PATHS as { CONFIG_PATH: string }).CONFIG_PATH = path.join(
    tmpHome,
    "copilot-api.config.json",
  )
})

afterEach(async () => {
  ;(PATHS as { CONFIG_PATH: string }).CONFIG_PATH = originalConfigPath
  await fs.rm(tmpHome, { recursive: true, force: true })
  if (fixture) {
    cleanupFixture(fixture)
    fixture = null
  }
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api", adminAuthRoutes)
  app.route("/admin/api/certificate", adminCertificateRoutes)
  return app
}

async function loginAs(app: Hono, key: string): Promise<string> {
  const res = await app.request("/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ttl_days: 1 }),
  })
  const cookie = res.headers.get("set-cookie") ?? ""
  return cookie.split(";")[0]
}

describe("admin certificate route", () => {
  test("unauthenticated → 401", async () => {
    const app = makeApp()
    const res = await app.request("/admin/api/certificate")
    expect(res.status).toBe(401)
  })

  test("non-super (admin) → 403", async () => {
    // Insert a regular admin token via the auth-tokens query layer
    const { createAuthToken } = await import("../src/db/queries/auth-tokens")
    await createAuthToken({
      name: "regular-admin",
      tokenHash: hashToken(ADMIN),
      tokenPrefix: ADMIN.slice(0, 8),
      isAdmin: true,
    })
    const app = makeApp()
    const cookie = await loginAs(app, ADMIN)
    const res = await app.request("/admin/api/certificate", {
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })

  test("super with no tls config → configured:false", async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, "{}")
    const app = makeApp()
    const cookie = await loginAs(app, SUPER)
    const res = await app.request("/admin/api/certificate", {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { configured: boolean; reason?: string }
    expect(body.configured).toBe(false)
    expect(body.reason).toBe("not_configured")
  })

  test("super with valid cert returns parsed metadata", async () => {
    fixture = makeSelfSignedCert("route.test", 30)
    await fs.writeFile(
      PATHS.CONFIG_PATH,
      JSON.stringify({
        domain: "route.test",
        tls: { cert: fixture.certPath, key: fixture.keyPath },
      }),
    )
    const app = makeApp()
    const cookie = await loginAs(app, SUPER)
    const res = await app.request("/admin/api/certificate", {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      configured: boolean
      subject?: string
      daysRemaining?: number
    }
    expect(body.configured).toBe(true)
    expect(body.subject).toContain("route.test")
    expect(body.daysRemaining).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/admin-certificate.test.ts`
Expected: FAIL with `Cannot find module '../src/routes/admin/certificate'`.

- [ ] **Step 3: Create the route**

Create `src/routes/admin/certificate.ts`:

```ts
import { Hono } from "hono"

import { readCertificateInfo } from "~/lib/certificate"
import { forwardError } from "~/lib/error"
import { sessionMiddleware } from "~/lib/session"

export const adminCertificateRoutes = new Hono()

adminCertificateRoutes.use("*", sessionMiddleware({ requireRole: "super" }))

adminCertificateRoutes.get("/", async (c) => {
  try {
    const info = await readCertificateInfo()
    return c.json(info)
  } catch (error) {
    return forwardError(c, error)
  }
})
```

- [ ] **Step 4: Mount the route**

Edit `src/routes/admin/route.ts`:

```ts
import { Hono } from "hono"

import { adminAuthRoutes } from "./auth"
import { adminCertificateRoutes } from "./certificate"
import { adminGithubAuthRoutes } from "./github-auth"
import { adminModelsRoutes } from "./models"
import { adminTokensRoutes } from "./tokens"
import { adminUsageRoutes } from "./usage"

export const adminRoutes = new Hono()

adminRoutes.route("/", adminAuthRoutes)
adminRoutes.route("/certificate", adminCertificateRoutes)
adminRoutes.route("/github", adminGithubAuthRoutes)
adminRoutes.route("/models", adminModelsRoutes)
adminRoutes.route("/tokens", adminTokensRoutes)
adminRoutes.route("/usage", adminUsageRoutes)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/admin-certificate.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Run full test suite + lint + typecheck**

Run: `bun test && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin/certificate.ts src/routes/admin/route.ts tests/admin-certificate.test.ts
git commit -m "feat(admin): expose GET /admin/api/certificate (super-only)"
```

---

## Task 3: Frontend types and API client

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: Add `CertificateInfo` to `frontend/src/types.ts`**

Append:

```ts
export type CertificateInfo =
  | {
      configured: false
      reason: "not_configured"
      hint: string
    }
  | {
      configured: true
      error: string
      certPath: string
    }
  | {
      configured: true
      domain: string | null
      subject: string
      issuer: string
      validFrom: string
      validTo: string
      daysRemaining: number
      expired: boolean
      certPath: string
    }
```

- [ ] **Step 2: Add `getCertificate()` to `frontend/src/api/client.ts`**

Add `CertificateInfo` to the import block:

```ts
import type {
  CertificateInfo,
  CreatedToken,
  // ...existing imports unchanged...
} from "../types"
```

Add this method inside the `api` object (e.g., after `listModels`):

```ts
  getCertificate: () => request<CertificateInfo>("/certificate"),
```

- [ ] **Step 3: Typecheck the frontend**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts
git commit -m "feat(frontend): add CertificateInfo type and getCertificate client"
```

---

## Task 4: Frontend `<TlsCertificateCard />` component

**Files:**
- Create: `frontend/src/components/TlsCertificateCard.tsx`

- [ ] **Step 1: Create the component**

Create `frontend/src/components/TlsCertificateCard.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react"

import { api } from "../api/client"
import type { CertificateInfo } from "../types"

type LoadState =
  | { kind: "loading" }
  | { kind: "data"; info: CertificateInfo }
  | { kind: "error"; message: string }

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function colorForDays(days: number, expired: boolean): string {
  if (expired || days < 7) return "#c0392b" // red
  if (days <= 30) return "#d4a017" // amber
  return "#1f8a4c" // green
}

export function TlsCertificateCard() {
  const [state, setState] = useState<LoadState>({ kind: "loading" })

  const load = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const info = await api.getCertificate()
      setState({ kind: "data", info })
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ margin: 0 }}>TLS Certificate</h3>
        <button onClick={() => void load()} disabled={state.kind === "loading"}>
          Refresh
        </button>
      </div>

      {state.kind === "loading" && <p className="label">Loading…</p>}

      {state.kind === "error" && (
        <p className="label" style={{ color: "#c0392b" }}>
          Failed to load: {state.message}
        </p>
      )}

      {state.kind === "data" && !state.info.configured && (
        <div className="field">
          <p>TLS not configured.</p>
          <p className="label">
            {state.info.hint.replace(
              "./scripts/cert.sh obtain --domain <your-domain>",
              "",
            )}
            <code>./scripts/cert.sh obtain --domain &lt;your-domain&gt;</code>
          </p>
        </div>
      )}

      {state.kind === "data"
        && state.info.configured
        && "error" in state.info && (
          <div className="field">
            <p style={{ color: "#c0392b" }}>
              Unable to read certificate: {state.info.error}
            </p>
            <p className="label">
              Path: <code>{state.info.certPath}</code>
            </p>
          </div>
        )}

      {state.kind === "data"
        && state.info.configured
        && "subject" in state.info && (
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              columnGap: 16,
              rowGap: 4,
              marginTop: 8,
            }}
          >
            <dt>Domain</dt>
            <dd>{state.info.domain ?? "—"}</dd>
            <dt>Subject</dt>
            <dd>
              <code>{state.info.subject}</code>
            </dd>
            <dt>Issuer</dt>
            <dd>{state.info.issuer}</dd>
            <dt>Not Before</dt>
            <dd>{formatDate(state.info.validFrom)}</dd>
            <dt>Not After</dt>
            <dd>{formatDate(state.info.validTo)}</dd>
            <dt>Status</dt>
            <dd
              style={{
                color: colorForDays(
                  state.info.daysRemaining,
                  state.info.expired,
                ),
                fontWeight: 600,
              }}
            >
              {state.info.expired
                ? `Expired ${Math.abs(state.info.daysRemaining)} days ago`
                : `Expires in ${state.info.daysRemaining} days`}
            </dd>
          </dl>
        )}
    </div>
  )
}

export default TlsCertificateCard
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/TlsCertificateCard.tsx
git commit -m "feat(frontend): add TlsCertificateCard component"
```

---

## Task 5: Render the card on the Settings page (super-only)

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Update Settings.tsx**

Replace the contents of `frontend/src/pages/Settings.tsx` with:

```tsx
import { useEffect, useState } from "react"

import { api } from "../api/client"
import { TlsCertificateCard } from "../components/TlsCertificateCard"
import type { MeResponse } from "../types"

const TTL_KEY = "cpk_preferred_ttl"

export function Settings() {
  const [ttl, setTtl] = useState<number>(1)
  const [me, setMe] = useState<MeResponse | null>(null)

  useEffect(() => {
    const v = globalThis.localStorage.getItem(TTL_KEY)
    if (v) setTtl(Number.parseInt(v, 10))
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  function update(next: number) {
    setTtl(next)
    globalThis.localStorage.setItem(TTL_KEY, String(next))
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

      {me?.role === "super" && <TlsCertificateCard />}
    </div>
  )
}

export default Settings
```

- [ ] **Step 2: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 3: Manual smoke test**

Run: `bun run dev`
- Log in as super-admin → open `/settings` → verify the card renders. With TLS unconfigured, expect the "not configured" branch with the `./scripts/cert.sh obtain ...` hint.
- Log in as a non-super (regular admin) token → `/settings` should NOT render the card. (Optionally hit `/admin/api/certificate` directly in DevTools and confirm 403.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Settings.tsx
git commit -m "feat(frontend): show TLS certificate card on Settings (super-only)"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run the whole pipeline**

Run: `bun test && bun run typecheck && bun run lint && bun run knip`
Expected: clean.

- [ ] **Step 2: Build to confirm bundling works**

Run: `bun run build`
Expected: build succeeds; `dist/main.js` updated.

- [ ] **Step 3: Verify spec coverage**

Read `docs/superpowers/specs/2026-04-28-tls-cert-expiry-card-design.md` once more and confirm: API contract matches, three response branches all implemented, super-only, no private key path returned, refresh button present, traffic-light coloring, `./scripts/cert.sh obtain` hint visible.
