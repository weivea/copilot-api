import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthToken } from "../src/db/queries/auth-tokens"
import { insertRequestLog } from "../src/db/queries/request-logs"
import { createSession } from "../src/db/queries/sessions"
import { adminUsageRoutes } from "../src/routes/admin/usage"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.dashboardEnabled = true
})

function makeApp(): Hono {
  const app = new Hono()
  app.route("/admin/api/usage", adminUsageRoutes)
  return app
}

async function asUser(tokenId: number): Promise<string> {
  const sid = await createSession({
    authTokenId: tokenId,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })
  return `cpk_session=${sid}`
}

async function asAdmin(): Promise<string> {
  const id = await createAuthToken({
    name: "a",
    tokenHash: "ah",
    tokenPrefix: "p",
    isAdmin: true,
  })
  return asUser(id)
}

describe("admin usage API", () => {
  test("summary for me returns own counts", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
      monthlyTokenLimit: 1000,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: Date.now(),
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 50,
    })
    const cookie = await asUser(id)
    const res = await makeApp().request(
      "/admin/api/usage/summary?token_id=me",
      { headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      requests_today: number
      tokens_today: number
      monthly_used: number
      monthly_limit: number | null
    }
    expect(body.requests_today).toBe(1)
    expect(body.tokens_today).toBe(50)
    expect(body.monthly_used).toBe(50)
    expect(body.monthly_limit).toBe(1000)
  })

  test("user cannot request token_id=all", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const cookie = await asUser(id)
    const res = await makeApp().request(
      "/admin/api/usage/summary?token_id=all",
      { headers: { cookie } },
    )
    expect(res.status).toBe(403)
  })

  test("admin per-token returns row per token", async () => {
    const cookie = await asAdmin()
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: Date.now(),
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 7,
    })
    const res = await makeApp().request(
      `/admin/api/usage/per-token?from=0&to=${Date.now() + 1000}`,
      { headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string; tokens: number }>
    expect(body.find((r) => r.name === "u")?.tokens).toBe(7)
  })

  test("timeseries day buckets", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const cookie = await asUser(id)
    const day = 86_400_000
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 5,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 1,
    })
    const res = await makeApp().request(
      `/admin/api/usage/timeseries?token_id=me&from=0&to=${day * 6}&bucket=day`,
      { headers: { cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ requests: number }>
    expect(body).toHaveLength(1)
    expect(body[0]?.requests).toBe(1)
  })

  test("recent returns last N for me", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const cookie = await asUser(id)
    for (let i = 0; i < 3; i++) {
      await insertRequestLog({
        authTokenId: id,
        timestamp: i,
        endpoint: "/x",
        statusCode: 200,
      })
    }
    const res = await makeApp().request(
      "/admin/api/usage/recent?token_id=me&limit=2",
      { headers: { cookie } },
    )
    const body = (await res.json()) as Array<{ timestamp: number }>
    expect(body.map((r) => r.timestamp)).toEqual([2, 1])
  })
})
