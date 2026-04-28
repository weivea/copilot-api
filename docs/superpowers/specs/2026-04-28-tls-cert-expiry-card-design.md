# TLS Certificate Expiry Card (Super-Admin)

**Date:** 2026-04-28
**Status:** Approved (design)
**Scope:** Allow super-admins to view the configured TLS certificate's
metadata — most importantly its expiration date — from the Settings page in
the web UI.

## Background

The project already supports running with HTTPS. `src/scripts/cert.ts` (and
its release-tarball equivalent `scripts/cert.sh`) drives certbot to obtain a
certificate and writes the resulting cert/key paths into
`~/.local/share/copilot-api/copilot-api.config.json` under a `tls` key.
Operators currently have no in-app way to see when that certificate expires;
they must shell into the host and inspect the PEM file by hand.

## Goal

Super-admins (the role distinguished from regular admins by
`state.superAdminTokenHash` in `src/routes/admin/auth.ts`) can open the
Settings page and see, at a glance:

- Which domain the certificate is for
- Who issued it
- Its validity window (Not Before / Not After)
- How many days remain (with traffic-light color coding)

Read-only. No renewal triggers, no email alerts, no banner.

## Non-Goals (YAGNI)

- Email/Slack alerts for impending expiry
- Global page-top banner when the cert is near expiry
- SAN list, SHA-256 fingerprint, or full chain display
- A "Renew now" button (renewal stays on the CLI: `./scripts/cert.sh renew`)
- New frontend test infrastructure (project currently has none)

## Architecture

```
Settings.tsx (renders card only when role === "super")
  └─ <TlsCertificateCard />
        └─ GET /admin/certificate
              └─ src/routes/admin/certificate.ts
                    ├─ requireSuperAdmin middleware
                    ├─ loadConfig()                  src/lib/config.ts
                    └─ readCertificateInfo(certPath) src/lib/certificate.ts (NEW)
                          └─ node:crypto X509Certificate
```

Bun's `node:crypto` exposes `X509Certificate`, so no third-party dependency
is needed and the single-file Bun executable build is unaffected (built-in
native modules are not bundled by tsdown).

### Files Touched

**New**

- `src/lib/certificate.ts` — pure function that reads + parses the cert
- `src/routes/admin/certificate.ts` — Hono router exposing the endpoint
- `tests/admin-certificate.test.ts` — backend tests
- `frontend/src/components/TlsCertificateCard.tsx` — UI card

**Modified**

- `src/routes/admin/route.ts` — mount `/certificate`
- `frontend/src/api/client.ts` — add `getCertificate()`
- `frontend/src/types.ts` — add `CertificateInfo` discriminated union
- `frontend/src/pages/Settings.tsx` — render the card for super-admins

## API Contract

### `GET /admin/certificate`

**Auth:** super-admin only. Non-super callers (admin, user, anonymous) get
HTTP 403.

**Response 200 — configured and parsed successfully**

```json
{
  "configured": true,
  "domain": "example.com",
  "subject": "CN=example.com",
  "issuer": "CN=R3, O=Let's Encrypt, C=US",
  "validFrom": "2026-02-01T00:00:00.000Z",
  "validTo": "2026-05-01T23:59:59.000Z",
  "daysRemaining": 42,
  "expired": false,
  "certPath": "/Users/.../live/example.com/fullchain.pem"
}
```

**Response 200 — TLS not configured** (no `tls` key in `config.json`)

```json
{
  "configured": false,
  "reason": "not_configured",
  "hint": "Run ./scripts/cert.sh obtain --domain <your-domain> to obtain a certificate."
}
```

**Response 200 — configured but read/parse failed**

```json
{
  "configured": true,
  "error": "ENOENT: no such file or directory",
  "certPath": "/Users/.../fullchain.pem"
}
```

**Response 403** — `{ "error": "forbidden" }` (existing project format)

### Why 200 for the "no cert" / "read failed" cases

These are display states, not transport errors. Returning 200 with a
discriminated union lets the frontend render all three branches from one
component without juggling HTTP status codes. 403 stays an HTTP error
because that genuinely is an authentication/authorization failure.

## Backend Implementation Detail

### `src/lib/certificate.ts`

```ts
export type CertificateInfo =
  | { configured: false; reason: "not_configured"; hint: string }
  | { configured: true; error: string; certPath: string }
  | {
      configured: true
      domain: string
      subject: string
      issuer: string
      validFrom: string  // ISO 8601
      validTo: string    // ISO 8601
      daysRemaining: number
      expired: boolean
      certPath: string
    }

export async function readCertificateInfo(): Promise<CertificateInfo>
```

Algorithm:

1. `loadConfig()` to get `config.tls?.cert` and `config.domain`.
2. If `tls.cert` is missing: return `{ configured: false, reason: "not_configured", hint: "..." }`.
3. `await fs.readFile(certPath)` then `new X509Certificate(pem)`.
4. Parse `cert.validFrom` / `cert.validTo` (RFC date strings) via `new Date()`,
   serialize back as ISO with `.toISOString()`.
5. `daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000)`.
   `expired = daysRemaining < 0`.
6. Any thrown error during steps 3–5 is caught and returned as
   `{ configured: true, error: e.message, certPath }`.

The function never throws — all failure modes are encoded in the return
union. This makes the route handler trivial and tests straightforward.

### `src/routes/admin/certificate.ts`

```ts
export const adminCertificateRoutes = new Hono()
adminCertificateRoutes.get("/", requireSuperAdmin, async (c) => {
  try {
    return c.json(await readCertificateInfo())
  } catch (error) {
    return forwardError(c, error)
  }
})
```

`requireSuperAdmin` checks the resolved session role. If
`src/routes/admin/auth.ts` already exposes a reusable helper, use it;
otherwise define a small middleware co-located with this route.

### Mounting

`src/routes/admin/route.ts` adds:

```ts
adminRoutes.route("/certificate", adminCertificateRoutes)
```

### Tests — `tests/admin-certificate.test.ts`

Unit (`readCertificateInfo`):

- not-configured branch (no `tls` in config)
- success branch (use a fixture PEM, assert ISO dates + daysRemaining math)
- error branch (point at non-existent path)

Route:

- super-admin → 200 + correct payload shape
- admin → 403
- unauthenticated user → 401/403 (whatever the existing middleware returns)

Mock `globalThis.fetch` only if needed; the cert read is local FS and uses
real fixtures.

## Frontend Implementation Detail

### `frontend/src/types.ts`

Export `CertificateInfo` mirroring the backend union exactly.

### `frontend/src/api/client.ts`

Add `getCertificate(): Promise<CertificateInfo>` wrapping
`GET /admin/certificate`.

### `frontend/src/components/TlsCertificateCard.tsx`

- `useEffect` on mount → call `client.getCertificate()`.
- Local state: `loading | data | error`.
- A small "Refresh" button re-runs the fetch.
- Branches:
  - **`configured: false`** — neutral info box: "TLS not configured." plus
    the `hint` rendered with the command in a `<code>` tag (clickable to
    copy).
  - **`configured: true && error`** — red error box showing `error` and
    `certPath`.
  - **success** — definition list / small table with Domain, Issuer,
    Not Before, Not After, Days Remaining.
  - Days-remaining color: `>30` green, `7–30` amber, `<7 || expired` red.

Use existing Tailwind primitives already in the codebase. No new UI deps.

### `frontend/src/pages/Settings.tsx`

Render `<TlsCertificateCard />` only when the current user's role is
`"super"`. The page already has access to the `me` object (or the same
source `App.tsx` uses); reuse it.

## Cross-cutting Concerns

**Refresh / caching.** Single fetch on mount + manual Refresh button. No
polling. No backend caching — file IO is cheap and operators want fresh
data when they click refresh.

**Security.**

- Endpoint is super-only.
- Response includes only the cert path that is already stored in
  `config.json`. The private key path is never read or returned.
- No PEM content, no fingerprint, no chain — minimum surface.

**Error handling.** All cert-reading failures are encoded in the response
union; the route handler still wraps in try/catch + `forwardError` for
defense-in-depth against unexpected upstream errors (e.g. config load).

## Open Questions

None at this time.
