import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { responsesRoutes } from "../src/routes/responses/route"

const realFetch = globalThis.fetch

beforeEach(() => {
  state.copilotToken = "test-token"
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("/v1/responses route", () => {
  test("non-streaming: forwards upstream JSON verbatim", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            status: "completed",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch

    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; object: string }
    expect(body.id).toBe("resp_1")
    expect(body.object).toBe("response")
  })

  test("rejects previous_response_id with 400", async () => {
    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
        previous_response_id: "resp_prev",
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("previous_response_id")
  })

  test("missing model returns 400", async () => {
    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    })
    expect(res.status).toBe(400)
  })
})
