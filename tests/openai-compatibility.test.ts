import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  resetResponsesRouting,
  recordResponsesOnlyModel,
} from "../src/lib/responses-routing"
import { state } from "../src/lib/state"
import { completionRoutes } from "../src/routes/chat-completions/route"
import { modelRoutes } from "../src/routes/models/route"
import { server } from "../src/server"

const realFetch = globalThis.fetch
const originalState = { ...state }

beforeEach(() => {
  resetResponsesRouting()
  state.copilotToken = "test-token"
  state.rateLimitSeconds = undefined
  state.manualApprove = false
  state.models = undefined
})
afterEach(() => {
  globalThis.fetch = realFetch
  Object.assign(state, originalState)
  resetResponsesRouting()
})

function request(body: unknown) {
  return completionRoutes.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function sentPayload(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string")
    throw new Error("Expected a JSON request body")
  return JSON.parse(init.body) as Record<string, unknown>
}

function upstreamSSE(data: Array<unknown>) {
  return new Response(
    data
      .map(
        (chunk) =>
          `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("OpenAI chat compatibility", () => {
  test("omitted token limits use upstream defaults instead of model maxima", async () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-test",
          name: "Test",
          vendor: "OpenAI",
          version: "1",
          object: "model",
          model_picker_enabled: true,
          capabilities: {
            family: "gpt",
            object: "model_capabilities",
            type: "chat",
            tokenizer: "cl100k_base",
            supports: {},
            limits: {
              max_output_tokens: 128000,
              max_non_streaming_output_tokens: 8192,
            },
          },
        },
      ],
    }
    let sent: Record<string, unknown> = {}
    globalThis.fetch = ((_url, init) => {
      sent = sentPayload(init)
      return Promise.resolve(Response.json({ id: "c1", choices: [] }))
    }) as typeof fetch
    const response = await request({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(200)
    expect(sent).not.toHaveProperty("max_tokens")
    expect(sent).not.toHaveProperty("max_completion_tokens")
  })

  test("validation preserves nested upstream-supported fields", async () => {
    let sent: unknown
    globalThis.fetch = ((_url, init) => {
      sent = sentPayload(init)
      return Promise.resolve(Response.json({ id: "c1", choices: [] }))
    }) as typeof fetch
    const body = {
      model: "gpt-test",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              prompt_cache_breakpoint: { ttl: "1h" },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object" },
            upstream_option: "preserved",
          },
        },
      ],
      stream_options: { include_usage: true, include_obfuscation: false },
    }
    const response = await request(body)
    expect(response.status).toBe(200)
    expect(sent).toEqual(body)
  })

  test("removing thinking blocks preserves metadata on remaining text parts", async () => {
    let sent: Record<string, unknown> = {}
    globalThis.fetch = ((_url, init) => {
      sent = sentPayload(init)
      return Promise.resolve(Response.json({ id: "c1", choices: [] }))
    }) as typeof fetch
    const text = {
      type: "text",
      text: "hello",
      prompt_cache_breakpoint: { ttl: "1h" },
    }
    const response = await request({
      model: "gpt-test",
      messages: [
        {
          role: "user",
          content: [{ type: "thinking", thinking: "internal" }, text],
        },
      ],
    })
    expect(response.status).toBe(200)
    expect(sent.messages).toEqual([{ role: "user", content: [text] }])
  })

  test("normalizes missing object and created fields in Copilot JSON responses", async () => {
    globalThis.fetch = ((_input: string | Request | URL) =>
      Promise.resolve(
        Response.json({
          id: "c1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
        }),
      )) as typeof fetch
    const response = await request({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      created: expect.any(Number) as unknown,
      model: "gpt-test",
    })
  })

  test.each([
    {},
    { model: "gpt-test", messages: [] },
    { model: "gpt-test", messages: [{ role: "user" }] },
    { model: "gpt-test", messages: [{ role: "invalid", content: "hi" }] },
    {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: -1,
    },
    {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{}],
    },
  ])("returns an OpenAI 400 error for invalid input %j", async (body) => {
    let called = false
    globalThis.fetch = Object.assign(
      (_input: string | Request | URL) => {
        called = true
        throw new Error("must not fetch")
      },
      { preconnect: realFetch.preconnect },
    )
    const response = await request(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: null,
      },
    })
    expect(called).toBe(false)
  })

  test("invalid JSON returns 400, not an internal error", async () => {
    const response = await completionRoutes.request("/", {
      method: "POST",
      body: "{",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  })

  test.each(["gpt-test", "o3-test", "claude-test"])(
    "preserves max_tokens for %s and accepts content-less assistant tool calls",
    async (model) => {
      let sent: Record<string, unknown> = {}
      globalThis.fetch = ((_url, init) => {
        sent = sentPayload(init)
        return Promise.resolve(Response.json({ id: "c1", model, choices: [] }))
      }) as typeof fetch
      const response = await request({
        model,
        max_tokens: 17,
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
      })
      expect(response.status).toBe(200)
      const gpt = model !== "claude-test"
      expect(sent[gpt ? "max_completion_tokens" : "max_tokens"]).toBe(17)
      expect(sent[gpt ? "max_tokens" : "max_completion_tokens"]).toBeUndefined()
    },
  )

  test("Responses fallback receives the client's token budget", async () => {
    recordResponsesOnlyModel("gpt-test")
    let sent: Record<string, unknown> = {}
    globalThis.fetch = ((_url, init) => {
      sent = sentPayload(init)
      return Promise.resolve(
        Response.json({
          id: "r1",
          model: "gpt-test",
          status: "completed",
          created_at: 1,
          output: [],
        }),
      )
    }) as typeof fetch
    expect(
      (
        await request({
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 17,
        })
      ).status,
    ).toBe(200)
    expect(sent.max_output_tokens).toBe(17)
  })

  test("preserves upstream error code, param and retry headers", async () => {
    globalThis.fetch = ((_input: string | Request | URL) =>
      Promise.resolve(
        Response.json(
          {
            error: {
              message: "Too many requests",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
              param: "model",
            },
          },
          {
            status: 429,
            headers: { "retry-after": "5", "x-request-id": "req-test" },
          },
        ),
      )) as typeof fetch
    const response = await request({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("5")
    expect(await response.json()).toEqual({
      error: {
        message: "Too many requests",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        param: "model",
      },
    })
  })

  test.each([true, false])(
    "stream include_usage=%s uses an empty-choices usage chunk only when requested",
    async (includeUsage) => {
      globalThis.fetch = ((_input: string | Request | URL) =>
        Promise.resolve(
          upstreamSSE([
            {
              id: "c1",
              model: "gpt-test",
              choices: [
                { index: 0, delta: { content: "hi" }, finish_reason: null },
              ],
            },
            {
              id: "c1",
              model: "gpt-test",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
              },
            },
            "[DONE]",
          ]),
        )) as typeof fetch
      const response = await request({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: includeUsage },
      })
      const text = await response.text()
      const chunks = text
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as {
              choices: Array<unknown>
              usage?: unknown
            },
        )
      const usageChunks = chunks.filter((chunk) => chunk.usage)
      for (const chunk of chunks.filter((chunk) => chunk.choices.length > 0)) {
        if (includeUsage) expect(chunk).toHaveProperty("usage", null)
        else expect(chunk).not.toHaveProperty("usage")
      }
      for (const chunk of chunks)
        expect(chunk).toMatchObject({
          object: "chat.completion.chunk",
          created: expect.any(Number) as unknown,
          model: "gpt-test",
        })
      expect(usageChunks).toHaveLength(includeUsage ? 1 : 0)
      if (includeUsage) expect(usageChunks[0].choices).toEqual([])
      expect(text.match(/data: \[DONE\]/g)).toHaveLength(1)
    },
  )

  test("truncated chat streams report an error instead of silent success", async () => {
    globalThis.fetch = ((_input: string | Request | URL) =>
      Promise.resolve(
        upstreamSSE([
          { id: "c1", choices: [{ index: 0, delta: { content: "partial" } }] },
        ]),
      )) as typeof fetch
    const response = await request({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })
    expect(await response.text()).toContain('"type":"upstream_error"')
  })
})

test("retrieves a single model and returns a structured missing-model error", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-test",
        name: "Test",
        vendor: "OpenAI",
        version: "1",
        object: "model",
        model_picker_enabled: true,
        capabilities: {
          family: "gpt",
          object: "model_capabilities",
          type: "chat",
          tokenizer: "cl100k_base",
          supports: {},
        },
      },
    ],
  }
  const found = await modelRoutes.request("/gpt-test")
  expect(found.status).toBe(200)
  expect(await found.json()).toMatchObject({
    id: "gpt-test",
    object: "model",
    owned_by: "OpenAI",
  })
  const listed = await modelRoutes.request("/")
  expect(await listed.json()).toMatchObject({
    object: "list",
    data: [{ id: "gpt-test", object: "model", owned_by: "OpenAI" }],
  })
  const missing = await modelRoutes.request("/missing")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({
    error: { code: "model_not_found" },
  })
})

test("models errors preserve upstream code and retry headers", async () => {
  const body = {
    error: {
      message: "Model catalog temporarily unavailable",
      type: "api_error",
      code: "service_unavailable",
      param: null,
    },
  }
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json(body, {
          status: 503,
          headers: { "retry-after": "5" },
        }),
      ),
    { preconnect: realFetch.preconnect },
  )
  const response = await modelRoutes.request("/")
  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("5")
  expect(await response.json()).toEqual(body)
})

test("unknown API routes return JSON rather than dashboard HTML", async () => {
  state.authEnabled = false
  for (const path of ["/v1/unknown", "/v1/completions", "/responses/missing"]) {
    const response = await server.request(path)
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toMatchObject({
      error: { code: "not_found" },
    })
  }
})
