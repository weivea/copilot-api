import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  createAuthToken,
  getAuthTokenById,
} from "../src/db/queries/auth-tokens"
import { recentLogs } from "../src/db/queries/request-logs"
import { state } from "../src/lib/state"
import { recordUsage, usageRecorder } from "../src/lib/usage-recorder"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
  state.logRetentionDays = 90
})

describe("usage-recorder", () => {
  test("records a row for an authed business request", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const app = new Hono()
    app.use(async (c, next) => {
      c.set("authTokenId", id)
      await next()
    })
    app.use(usageRecorder())
    app.post("/v1/messages", async (c) => {
      await recordUsage(c, {
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
      })
      return c.json({ ok: true })
    })
    const res = await app.request("/v1/messages", { method: "POST" })
    expect(res.status).toBe(200)
    const logs = await recentLogs({ tokenId: id, limit: 10 })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.totalTokens).toBe(8)
    expect(logs[0]?.endpoint).toBe("/v1/messages")
    expect(logs[0]?.statusCode).toBe(200)
    const tok = await getAuthTokenById(id)
    expect(tok?.lifetimeTokenUsed).toBe(8)
    expect(tok?.lastUsedAt).toBeGreaterThan(0)
  })

  test("records a row even if recordUsage is never called (no token counts)", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const app = new Hono()
    app.use(async (c, next) => {
      c.set("authTokenId", id)
      await next()
    })
    app.use(usageRecorder())
    app.post("/v1/messages", (c) => c.text("ok"))
    await app.request("/v1/messages", { method: "POST" })
    const logs = await recentLogs({ tokenId: id, limit: 10 })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.totalTokens).toBeNull()
  })

  test("does not record for super admin (no authTokenId)", async () => {
    const app = new Hono()
    app.use(usageRecorder())
    app.post("/v1/messages", (c) => c.text("ok"))
    await app.request("/v1/messages", { method: "POST" })
    const logs = await recentLogs({ limit: 10 })
    expect(logs).toHaveLength(0)
  })

  test("records 5xx with status code", async () => {
    const id = await createAuthToken({
      name: "u",
      tokenHash: "h",
      tokenPrefix: "p",
    })
    const app = new Hono()
    app.use(async (c, next) => {
      c.set("authTokenId", id)
      await next()
    })
    app.use(usageRecorder())
    app.post("/v1/messages", (c) => c.json({ err: 1 }, 500))
    await app.request("/v1/messages", { method: "POST" })
    const logs = await recentLogs({ tokenId: id, limit: 10 })
    expect(logs[0]?.statusCode).toBe(500)
  })
})
