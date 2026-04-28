import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
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
