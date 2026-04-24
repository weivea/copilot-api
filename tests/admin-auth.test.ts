import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthToken } from "../src/db/queries/auth-tokens"
import { hashToken } from "../src/lib/auth-token-utils"
import { sessionMiddleware } from "../src/lib/session"
import { state } from "../src/lib/state"
import { adminAuthRoutes } from "../src/routes/admin/auth"
import { makeTestDb } from "./helpers/test-db"

const SUPER =
  "cpk-super000000000000000000000000000000000000000000000000000000000000"

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
    const tokenPlain =
      "cpk-user0000000000000000000000000000000000000000000000000000000000000"
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
    const tokenPlain =
      "cpk-admin000000000000000000000000000000000000000000000000000000000000"
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
