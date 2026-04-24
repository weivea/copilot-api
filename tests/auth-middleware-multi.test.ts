import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthToken } from "../src/db/queries/auth-tokens"
import { insertRequestLog } from "../src/db/queries/request-logs"
import { authMiddleware } from "../src/lib/auth-middleware"
import { hashToken } from "../src/lib/auth-token-utils"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

const SUPER =
  "cpk-super000000000000000000000000000000000000000000000000000000000000"

beforeEach(() => {
  makeTestDb()
  state.authEnabled = true
  state.superAdminToken = SUPER
  state.superAdminTokenHash = hashToken(SUPER)
})

function makeApp(): Hono {
  const app = new Hono()
  app.use(authMiddleware())
  app.post("/v1/messages", (c) =>
    c.json({ tokenId: c.get("authTokenId") ?? null }),
  )
  return app
}

describe("authMiddleware (multi)", () => {
  test("super admin token passes and sets no tokenId", async () => {
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPER}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tokenId: null })
  })

  test("DB token passes and sets c.authTokenId", async () => {
    const tokenPlain =
      "cpk-userusr00000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "cpk-user...0000",
    })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tokenId: id })
  })

  test("disabled DB token returns 401", async () => {
    const tokenPlain =
      "cpk-dis0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
    })
    const { updateAuthToken } = await import("../src/db/queries/auth-tokens")
    await updateAuthToken(id, { isDisabled: true })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(401)
  })

  test("RPM limit returns 429", async () => {
    const tokenPlain =
      "cpk-rpm0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
      rpmLimit: 1,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: Date.now(),
      endpoint: "/v1/messages",
      statusCode: 200,
    })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_exceeded")
  })

  test("monthly limit returns 429", async () => {
    const tokenPlain =
      "cpk-mon0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
      monthlyTokenLimit: 100,
    })
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    await insertRequestLog({
      authTokenId: id,
      timestamp: monthStart.getTime() + 1,
      endpoint: "/v1/messages",
      statusCode: 200,
      totalTokens: 100,
    })
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("monthly_quota_exceeded")
  })

  test("lifetime limit returns 403", async () => {
    const tokenPlain =
      "cpk-lif0000000000000000000000000000000000000000000000000000000000000"
    const id = await createAuthToken({
      name: "u",
      tokenHash: hashToken(tokenPlain),
      tokenPrefix: "p",
      lifetimeTokenLimit: 50,
    })
    const { setLifetimeUsed } = await import("../src/db/queries/auth-tokens")
    await setLifetimeUsed(id, 50)
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": tokenPlain },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("account_quota_exhausted")
  })

  test("unknown token returns 401", async () => {
    const res = await makeApp().request("/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer cpk-nope" },
    })
    expect(res.status).toBe(401)
  })

  test("authEnabled=false bypasses everything", async () => {
    state.authEnabled = false
    const res = await makeApp().request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(200)
  })
})
