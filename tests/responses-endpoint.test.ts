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
  test("accepts OpenAI easy-input messages with string content", async () => {
    let vision = ""
    globalThis.fetch = ((_url, init) => {
      vision = new Headers(init?.headers).get("copilot-vision-request") ?? ""
      return Promise.resolve(
        Response.json({
          id: "resp_easy",
          object: "response",
          status: "completed",
          output: [],
        }),
      )
    }) as typeof fetch
    const res = await responsesRoutes.request("/", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "resp_easy" })
    expect(vision).not.toBe("true")
  })

  test("malformed JSON returns an OpenAI invalid-request error", async () => {
    const res = await responsesRoutes.request("/", {
      method: "POST",
      body: "{",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  })

  test("reports a truncated Responses stream using an error event", async () => {
    globalThis.fetch = ((_input: string | Request | URL) =>
      Promise.resolve(
        new Response(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      )) as typeof fetch
    const res = await responsesRoutes.request("/", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-test", input: "hi", stream: true }),
    })
    const body = await res.text()
    expect(body).toContain("event: error")
    expect(body).toContain('"code":"upstream_error"')
    expect(body).not.toContain("event: response.completed")
  })

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

  test.each([
    {},
    { store: true },
    { store: false },
    { store: null },
    { background: true },
    { previous_response_id: "resp_prev" },
  ])("preserves upstream-controlled state options %j", async (options) => {
    let sent: unknown
    const seenHeaders: Array<Headers> = []
    globalThis.fetch = ((_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON body")
      sent = JSON.parse(init.body) as unknown
      seenHeaders.push(new Headers(init.headers))
      return Promise.resolve(
        Response.json({
          id: "resp_state",
          object: "response",
          status: "completed",
          output: [],
        }),
      )
    }) as typeof fetch
    const body = { model: "gpt-5.5", input: "hi", ...options }
    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    expect(sent).toEqual(body)
    expect(seenHeaders[0].get("x-initiator")).toBe(
      "previous_response_id" in options ? "agent" : "user",
    )
  })

  test("unsupported upstream options preserve the actual upstream error", async () => {
    const upstream = {
      error: {
        message: "Response storage is unavailable",
        type: "invalid_request_error",
        param: "store",
        code: "unsupported_parameter",
      },
    }
    globalThis.fetch = Object.assign(
      () => Promise.resolve(Response.json(upstream, { status: 400 })),
      { preconnect: realFetch.preconnect },
    )
    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
        store: true,
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(upstream)
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
