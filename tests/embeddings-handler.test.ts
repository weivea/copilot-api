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
      data: Array<{ embedding: Array<number> }>
      usage: { prompt_tokens: number }
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3])
    expect(body.usage.prompt_tokens).toBe(1)
  })
})
