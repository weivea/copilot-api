import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { requireCopilotReady } from "../src/lib/copilot-availability"
import { state } from "../src/lib/state"

beforeEach(() => {
  state.copilotToken = undefined
})

function makeApp(): Hono {
  const app = new Hono()
  app.use("/protected/*", requireCopilotReady())
  app.post("/protected/echo", (c) => c.json({ ok: true }))
  return app
}

describe("requireCopilotReady", () => {
  test("returns 503 with copilot_unavailable when no token", async () => {
    const app = makeApp()
    const res = await app.request("/protected/echo", { method: "POST" })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("copilot_unavailable")
  })

  test("passes through when token is set", async () => {
    state.copilotToken = "abc"
    const app = makeApp()
    const res = await app.request("/protected/echo", { method: "POST" })
    expect(res.status).toBe(200)
  })
})
