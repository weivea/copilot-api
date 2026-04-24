import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { hashToken } from "../src/lib/auth-token-utils"
import { state } from "../src/lib/state"
import { adminAuthRoutes } from "../src/routes/admin/auth"
import { adminGithubAuthRoutes } from "../src/routes/admin/github-auth"
import { __resetDeviceFlowsForTest } from "../src/services/github/device-flow-manager"
import { makeTestDb } from "./helpers/test-db"

const SUPER =
  "cpk-super000000000000000000000000000000000000000000000000000000000000"

const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
  state.githubToken = undefined
  state.githubLogin = undefined
  state.copilotToken = undefined
  __resetDeviceFlowsForTest()
  globalThis.fetch = ORIGINAL_FETCH
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api", adminAuthRoutes)
  app.route("/admin/api/github", adminGithubAuthRoutes)
  return app
}

async function loginAsSuper(app: Hono): Promise<string> {
  const res = await app.request("/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: SUPER, ttl_days: 1 }),
  })
  const cookie = res.headers.get("set-cookie") ?? ""
  return cookie.split(";")[0]
}

describe("admin github auth routes", () => {
  test("status without auth → 401", async () => {
    const app = makeApp()
    const res = await app.request("/admin/api/github/status")
    expect(res.status).toBe(401)
  })

  test("status as super returns connection info", async () => {
    const app = makeApp()
    const cookie = await loginAsSuper(app)
    const res = await app.request("/admin/api/github/status", {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      hasToken: boolean
      copilotReady: boolean
    }
    expect(body.hasToken).toBe(false)
    expect(body.copilotReady).toBe(false)
  })

  test("start device flow returns user_code", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "D",
            user_code: "USER",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch

    const app = makeApp()
    const cookie = await loginAsSuper(app)
    const res = await app.request("/admin/api/github/device-flow/start", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { flow_id: string; user_code: string }
    expect(body.user_code).toBe("USER")
    expect(body.flow_id.length).toBeGreaterThan(0)
  })

  test("get device-flow by id returns status", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "D",
            user_code: "USER",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch

    const app = makeApp()
    const cookie = await loginAsSuper(app)
    const start = await app.request("/admin/api/github/device-flow/start", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    const { flow_id } = (await start.json()) as { flow_id: string }

    const res = await app.request(`/admin/api/github/device-flow/${flow_id}`, {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe("pending")
  })

  test("non-super admin token gets 403", async () => {
    const { createAuthToken } = await import("../src/db/queries/auth-tokens")
    const adminPlain =
      "cpk-admin000000000000000000000000000000000000000000000000000000000"
    await createAuthToken({
      name: "admin",
      tokenHash: hashToken(adminPlain),
      tokenPrefix: "cpk-admi",
      isAdmin: true,
    })
    const app = makeApp()
    const loginRes = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: adminPlain, ttl_days: 1 }),
    })
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]
    const res = await app.request("/admin/api/github/status", {
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })
})
