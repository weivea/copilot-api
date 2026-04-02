import { describe, test, expect, beforeEach } from "bun:test"
import { Hono } from "hono"

import { authMiddleware } from "../src/lib/auth-middleware"
import { state } from "../src/lib/state"

function createTestApp(): Hono {
  const app = new Hono()
  app.use(authMiddleware())
  app.get("/", (c) => c.text("health"))
  app.post("/v1/chat/completions", (c) => c.text("ok"))
  app.post("/v1/messages", (c) => c.text("ok"))
  return app
}

describe("authMiddleware", () => {
  beforeEach(() => {
    state.authEnabled = true
    state.authToken =
      "cpk-testtoken1234567890abcdef1234567890abcdef1234567890abcdef12345678"
  })

  test("should allow requests with valid Bearer token", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${state.authToken}` },
    })
    expect(res.status).toBe(200)
  })

  test("should allow requests with valid x-api-key", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/messages", {
      method: "POST",
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      headers: { "x-api-key": state.authToken! },
    })
    expect(res.status).toBe(200)
  })

  test("should prefer Authorization header over x-api-key", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.authToken}`,
        "x-api-key": "wrong-token",
      },
    })
    expect(res.status).toBe(200)
  })

  test("should return 401 when no auth headers provided", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("auth_error")
  })

  test("should return 401 when token is invalid", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("auth_error")
  })

  test("should skip auth for root health check path", async () => {
    const app = createTestApp()
    const res = await app.request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("health")
  })

  test("should skip auth when authEnabled is false", async () => {
    state.authEnabled = false
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
    })
    expect(res.status).toBe(200)
  })

  test("should return 401 when Authorization header has no Bearer prefix", async () => {
    const app = createTestApp()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      headers: { Authorization: state.authToken! },
    })
    expect(res.status).toBe(401)
  })
})
