import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"
import { embeddingRoutes } from "../src/routes/embeddings/route"
import { makeTestDb } from "./helpers/test-db"

const originalFetch = globalThis.fetch

beforeEach(() => {
  makeTestDb()
  state.copilotToken = "test-token"
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("embeddings handler", () => {
  test.each([
    { format: "base64", upstream: [1, -2], expected: "AACAPwAAAMA=" },
    { format: "base64", upstream: "AACAPwAAAMA=", expected: "AACAPwAAAMA=" },
    { format: "float", upstream: "AACAPwAAAMA=", expected: [1, -2] },
    { format: undefined, upstream: "AACAPwAAAMA=", expected: [1, -2] },
  ])(
    "returns the requested embedding encoding %j",
    async ({ format, upstream, expected }) => {
      let sent: unknown
      globalThis.fetch = ((_url, init) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON body")
        sent = JSON.parse(init.body) as unknown
        return Promise.resolve(
          Response.json({
            data: [{ object: "embedding", index: 0, embedding: upstream }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        )
      }) as typeof fetch
      const res = await embeddingRoutes.request("/", {
        method: "POST",
        body: JSON.stringify({
          model: "test",
          input: [[1, 2]],
          dimensions: 2,
          encoding_format: format,
          upstream_option: "preserved",
        }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        data: [{ embedding: expected }],
      })
      expect(sent).toMatchObject({
        input: [[1, 2]],
        dimensions: 2,
        upstream_option: "preserved",
      })
    },
  )

  test.each(["not-base64", "AAAA", "AACAfw==", []])(
    "invalid upstream vectors return 502: %j",
    async (embedding) => {
      globalThis.fetch = Object.assign(
        () =>
          Promise.resolve(
            Response.json({
              data: [{ object: "embedding", index: 0, embedding }],
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
          ),
        { preconnect: originalFetch.preconnect },
      )
      const res = await embeddingRoutes.request("/", {
        method: "POST",
        body: JSON.stringify({ model: "test", input: "hi" }),
      })
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({
        error: {
          type: "api_error",
          message: "Upstream returned an invalid embedding vector",
        },
      })
    },
  )

  test("invalid embeddings input returns 400 before contacting upstream", async () => {
    let called = false
    globalThis.fetch = Object.assign(
      () => {
        called = true
        return Promise.reject(new Error("Must not call upstream"))
      },
      { preconnect: originalFetch.preconnect },
    )
    const res = await embeddingRoutes.request("/", {
      method: "POST",
      body: JSON.stringify({ model: "test", input: [] }),
    })
    expect(res.status).toBe(400)
    expect(called).toBe(false)
    expect(await res.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  })

  test("succeeds when upstream omits top-level object and model", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
            ],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "hi",
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      model: string
      data: Array<{ embedding: Array<number> }>
      usage: { prompt_tokens: number }
    }
    expect(body.object).toBe("list")
    expect(body.model).toBe("text-embedding-3-small")
    expect(body.data).toHaveLength(1)
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3])
    expect(body.usage.prompt_tokens).toBe(1)
  })
})
