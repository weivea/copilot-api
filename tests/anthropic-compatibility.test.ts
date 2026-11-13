import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "../src/services/copilot/create-chat-completions"
import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { messageRoutes } from "../src/routes/messages/route"
import { server } from "../src/server"

const realFetch = globalThis.fetch
const originalState = { ...state }

function model(id: string, endpoints: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      supports: {},
    },
  }
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.authEnabled = false
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.models = {
    object: "list",
    data: [
      model("claude-sonnet-4.5", ["/v1/messages"]),
      model("gpt-test", ["/chat/completions"]),
    ],
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  Object.assign(state, originalState)
})

function requestURL(input: string | URL | Request) {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(requestURL(input), init)),
    { preconnect: realFetch.preconnect },
  )
}

function body(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected JSON body")
  return JSON.parse(init.body) as Record<string, unknown>
}

function request(payload: unknown, path = "/") {
  return messageRoutes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

const nativePayload = {
  model: "claude-sonnet-4.5",
  max_tokens: 32,
  messages: [{ role: "user", content: "Hi" }],
}
const nativeResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4.5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
}

function sse(data: Array<unknown>, native = false) {
  return new Response(
    data
      .map((item) => {
        if (item === "[DONE]") return "data: [DONE]\n\n"
        const event =
          (
            native
            && typeof item === "object"
            && item !== null
            && "type" in item
          ) ?
            `event: ${String(item.type)}\n`
          : ""
        return `${event}data: ${JSON.stringify(item)}\n\n`
      })
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function chunk(
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finish: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "chat_1",
    model: "gpt-test",
    created: 1,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  }
}

interface StreamEvent {
  type: string
  index?: number
  content_block?: { type: string; name?: string }
  delta?: { stop_reason?: string; partial_json?: string }
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

async function events(response: Response): Promise<Array<StreamEvent>> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent)
}

describe("Anthropic request and error compatibility", () => {
  test.each([
    {},
    { ...nativePayload, max_tokens: undefined },
    { ...nativePayload, max_tokens: -1 },
    { ...nativePayload, messages: [] },
    { ...nativePayload, messages: [{ role: "system", content: "Hi" }] },
    { ...nativePayload, messages: [{ role: "user" }] },
    { ...nativePayload, model: "gpt-test", tool_choice: { type: "tool" } },
    { ...nativePayload, model: "gpt-test", future_option: { enabled: true } },
    { ...nativePayload, model: "gpt-test", thinking: { type: "enabled" } },
    { ...nativePayload, model: "gpt-test", thinking: { type: "adaptive" } },
  ])(
    "rejects malformed Messages input with Anthropic errors: %j",
    async (payload) => {
      mockFetch(() => {
        throw new Error("Validation must happen before fetch")
      })
      const response = await request(payload)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error" },
      })
    },
  )

  test.each(["/", "/count_tokens"])(
    "invalid JSON returns an Anthropic 400 on %s",
    async (path) => {
      const response = await messageRoutes.request(path, {
        method: "POST",
        body: "{",
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error" },
      })
    },
  )

  test("native passthrough preserves modern blocks, cache metadata, and zero output budget", async () => {
    const payload = {
      ...nativePayload,
      max_tokens: 0,
      system: [
        {
          type: "text",
          text: "Be helpful",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "Example",
              },
              citations: { enabled: true },
            },
          ],
        },
      ],
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "mcp_toolset", mcp_server_name: "test-server" },
      ],
      future_option: { enabled: true },
      output_config: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
    }
    mockFetch((url, init) => {
      expect(url.endsWith("/v1/messages")).toBe(true)
      expect(body(init)).toEqual(payload)
      return Response.json(nativeResponse, {
        headers: {
          "request-id": "req_native",
          "anthropic-ratelimit-requests-remaining": "42",
        },
      })
    })
    const response = await request(payload)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(nativeResponse)
    expect(response.headers.get("request-id")).toBe("req_native")
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe(
      "42",
    )
  })

  test("dated version aliases select the matching native model, not an older generation", async () => {
    mockFetch((url, init) => {
      expect(url.endsWith("/v1/messages")).toBe(true)
      expect(body(init).model).toBe("claude-sonnet-4.5")
      return Response.json(nativeResponse)
    })
    expect(
      (await request({ ...nativePayload, model: "claude-sonnet-4-5-20250929" }))
        .status,
    ).toBe(200)
  })

  test.each(["claude-3-7-sonnet-20250219", "claude-3-7-sonnet-latest"])(
    "older Claude version aliases match the catalog: %s",
    async (alias) => {
      state.models = {
        object: "list",
        data: [model("claude-3.7-sonnet", ["/messages"])],
      }
      mockFetch((_url, init) => {
        expect(body(init).model).toBe("claude-3.7-sonnet")
        return Response.json(nativeResponse)
      })
      expect((await request({ ...nativePayload, model: alias })).status).toBe(
        200,
      )
    },
  )

  test("native HTTP errors retain their envelope, request ID, and retry hints", async () => {
    const upstream = {
      type: "error",
      error: { type: "overloaded_error", message: "Busy", upstream_field: 1 },
      request_id: "req_body",
    }
    mockFetch(() =>
      Response.json(upstream, {
        status: 529,
        headers: { "request-id": "req_header", "retry-after": "5" },
      }),
    )
    const response = await request(nativePayload)
    expect(response.status).toBe(529)
    expect(await response.json()).toEqual(upstream)
    expect(response.headers.get("request-id")).toBe("req_header")
    expect(response.headers.get("retry-after")).toBe("5")
  })

  test("auth and availability middleware also return Anthropic error envelopes", async () => {
    const missing = await server.request("/v1/messages/missing")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    })
    state.authEnabled = true
    const unauthorized = await server.request("/v1/messages", {
      method: "POST",
    })
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    })
    state.authEnabled = false
    state.copilotToken = undefined
    const unavailable = await server.request("/v1/messages/count_tokens", {
      method: "POST",
    })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    })
  })

  test("fallback preserves modern model IDs, nested tool results, and parallel-tool settings", async () => {
    state.models = {
      object: "list",
      data: [model("claude-opus-4-5", ["/chat/completions"])],
    }
    mockFetch((_url, init) => {
      const payload = body(init)
      expect(payload.model).toBe("claude-opus-4-5")
      expect(payload.parallel_tool_calls).toBe(false)
      expect(payload.messages).toEqual([
        {
          role: "tool",
          tool_call_id: "tool_1",
          content: [
            { type: "text", text: "Done" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/image.png" },
            },
          ],
        },
      ])
      return Response.json({
        id: "c1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
      })
    })
    const response = await request({
      model: "claude-opus-4-5",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [
                { type: "text", text: "Done" },
                {
                  type: "image",
                  source: { type: "url", url: "https://example.com/image.png" },
                },
              ],
            },
          ],
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    })
    expect(response.status).toBe(200)
  })

  test("fallback rejects unrepresentable content instead of silently dropping it", async () => {
    mockFetch(() => {
      throw new Error("Must not fetch")
    })
    const response = await request({
      ...nativePayload,
      model: "gpt-test",
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "text", data: "Important" } },
          ],
        },
      ],
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ type: "error" })
  })
})

test.each([false, true])(
  "forced tool calls return tool_use even if Copilot reports stop (stream=%s)",
  async (stream) => {
    const tool = {
      id: "call_1",
      type: "function" as const,
      function: { name: "lookup", arguments: '{"city":"Paris"}' },
    }
    mockFetch(() =>
      stream ?
        sse([
          chunk({ tool_calls: [{ ...tool, index: 0 }] }),
          chunk({}, "stop"),
          "[DONE]",
        ])
      : Response.json({
          id: "chat_1",
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: [tool] },
              finish_reason: "stop",
            },
          ],
        }),
    )
    const response = await request({
      ...nativePayload,
      model: "gpt-test",
      stream,
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "lookup" },
    })
    expect(response.status).toBe(200)
    if (stream) {
      const result = await events(response)
      expect(
        result.find((event) => event.type === "message_delta")?.delta
          ?.stop_reason,
      ).toBe("tool_use")
    } else {
      expect(await response.json()).toMatchObject({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", name: "lookup", input: { city: "Paris" } },
        ],
      })
    }
  },
)

describe("Anthropic token counting", () => {
  const countPayload = {
    model: nativePayload.model,
    messages: nativePayload.messages,
  }

  test("native missing-model errors do not fall back to local estimates", async () => {
    mockFetch(() =>
      Response.json(
        {
          type: "error",
          error: {
            type: "not_found_error",
            code: "model_not_found",
            message: "Unknown model",
          },
        },
        { status: 404 },
      ),
    )
    const response = await request(countPayload, "/count_tokens")
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    })
    expect(response.headers.get("x-token-count-estimated")).toBeNull()
  })

  test("uses native counting without requiring or injecting max_tokens", async () => {
    mockFetch((url, init) => {
      expect(url.endsWith("/v1/messages/count_tokens")).toBe(true)
      expect(body(init)).toEqual(countPayload)
      return Response.json({ input_tokens: 123 })
    })
    const response = await request(countPayload, "/count_tokens")
    expect(await response.json()).toEqual({ input_tokens: 123 })
    expect(response.headers.get("x-token-count-estimated")).toBe("false")
  })

  test.each([404, 405, 501])(
    "unavailable native count endpoint %i uses a marked local estimate",
    async (status) => {
      mockFetch(() => new Response("Endpoint unavailable", { status }))
      const response = await request(countPayload, "/count_tokens")
      expect(response.status).toBe(200)
      expect(response.headers.get("x-token-count-estimated")).toBe("true")
      const result = (await response.json()) as { input_tokens: number }
      expect(result.input_tokens).toBeGreaterThan(1)
    },
  )

  test("upstream rate limits are not hidden by a fake or estimated count", async () => {
    mockFetch(() =>
      Response.json(
        {
          type: "error",
          error: { type: "rate_limit_error", message: "Slow down" },
        },
        { status: 429, headers: { "retry-after": "7" } },
      ),
    )
    const response = await request(countPayload, "/count_tokens")
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("7")
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error" },
    })
  })

  test("unknown models do not return a fabricated token count of one", async () => {
    mockFetch(() => {
      throw new Error("Must not fetch")
    })
    const response = await request(
      { ...countPayload, model: "unknown-model" },
      "/count_tokens",
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    })
  })

  test("upstream counting is independent of native Messages generation support", async () => {
    mockFetch((url, init) => {
      expect(url.endsWith("/v1/messages/count_tokens")).toBe(true)
      expect(body(init).model).toBe("gpt-test")
      return Response.json({ input_tokens: 22 })
    })
    const response = await request(
      { ...countPayload, model: "gpt-test" },
      "/count_tokens",
    )
    expect(await response.json()).toEqual({ input_tokens: 22 })
    expect(response.headers.get("x-token-count-estimated")).toBe("false")
  })

  test.each([
    null,
    {},
    { input_tokens: -1 },
    { input_tokens: 1.5 },
    { input_tokens: "22" },
  ])(
    "invalid upstream counts return a 502, not a fake success: %j",
    async (payload) => {
      mockFetch(() => Response.json(payload))
      const response = await request(countPayload, "/count_tokens")
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "api_error" },
      })
    },
  )

  test("local estimates count assistant history and require no output limit", async () => {
    mockFetch(() => new Response("Not implemented", { status: 501 }))
    const simple = await request(
      { ...countPayload, model: "gpt-test" },
      "/count_tokens",
    )
    const history = await request(
      {
        model: "gpt-test",
        messages: [
          ...countPayload.messages,
          {
            role: "assistant",
            content:
              "A substantially longer assistant response to include in the input.",
          },
        ],
      },
      "/count_tokens",
    )
    const a = (await simple.json()) as { input_tokens: number }
    const b = (await history.json()) as { input_tokens: number }
    expect(b.input_tokens).toBeGreaterThan(a.input_tokens)
  })
})

describe("Anthropic streaming", () => {
  test("native terminal events are recognized from JSON data without an event field", async () => {
    mockFetch(() => sse([{ type: "message_stop" }]))
    const result = await events(
      await request({ ...nativePayload, stream: true }),
    )
    expect(result).toEqual([{ type: "message_stop" }])
  })

  test.each(["tool_calls", "length"] as const)(
    "partial tool arguments with finish_reason=%s are handled explicitly",
    async (finish) => {
      mockFetch(() =>
        sse([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "partial",
                function: { name: "lookup", arguments: '{"city":' },
              },
            ],
          }),
          chunk({}, finish),
          "[DONE]",
        ]),
      )
      const result = await events(
        await request({ ...nativePayload, model: "gpt-test", stream: true }),
      )
      if (finish === "length") {
        expect(
          result.find((event) => event.type === "message_delta")?.delta
            ?.stop_reason,
        ).toBe("max_tokens")
        expect(result.at(-1)?.type).toBe("message_stop")
      } else {
        expect(result.some((event) => event.type === "error")).toBe(true)
        expect(result.some((event) => event.type === "message_stop")).toBe(
          false,
        )
      }
    },
  )

  test.each(["native", "translated"])(
    "%s streams report truncation without a successful message_stop",
    async (mode) => {
      const native = mode === "native"
      mockFetch(() =>
        native ?
          sse(
            [
              {
                type: "message_start",
                message: { ...nativeResponse, content: [] },
              },
            ],
            true,
          )
        : sse([chunk({ content: "Partial" })]),
      )
      const response = await request({
        ...nativePayload,
        model: native ? nativePayload.model : "gpt-test",
        stream: true,
      })
      const result = await events(response)
      expect(result.some((event) => event.type === "error")).toBe(true)
      expect(result.some((event) => event.type === "message_stop")).toBe(false)
      expect(result.some((event) => event.type === "message_delta")).toBe(false)
    },
  )

  test("translated streams request final usage and correctly separate cache tokens", async () => {
    mockFetch((_url, init) => {
      expect(body(init).stream_options).toEqual({ include_usage: true })
      expect(body(init).max_completion_tokens).toBe(32)
      return sse([
        chunk({ content: "OK" }),
        chunk({}, "stop"),
        {
          ...chunk({}),
          choices: [],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 2,
            total_tokens: 22,
            prompt_tokens_details: {
              cached_tokens: 4,
              cache_creation_input_tokens: 3,
            },
          },
        },
        "[DONE]",
      ])
    })
    const result = await events(
      await request({ ...nativePayload, model: "gpt-test", stream: true }),
    )
    const final = result.filter((event) => event.type === "message_delta")
    expect(final).toHaveLength(1)
    expect(final[0].usage).toEqual({
      input_tokens: 13,
      output_tokens: 2,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 3,
    })
    expect(result.at(-1)?.type).toBe("message_stop")
  })

  test("interleaved parallel tool arguments never target an already closed block", async () => {
    mockFetch(() =>
      sse([
        chunk({
          tool_calls: [
            { index: 0, id: "a", function: { name: "look", arguments: "" } },
            { index: 1, id: "b", function: { name: "other", arguments: "" } },
          ],
        }),
        chunk({
          tool_calls: [
            { index: 0, function: { name: "up", arguments: '{"a":' } },
            { index: 1, function: { arguments: '{"b":' } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: "2}" } }] }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ]),
    )
    const result = await events(
      await request({ ...nativePayload, model: "gpt-test", stream: true }),
    )
    const open = new Set<number>()
    const argumentsByIndex = new Map<number, string>()
    const names: Array<string | undefined> = []
    for (const event of result) {
      if (event.index === undefined) continue
      switch (event.type) {
        case "content_block_start": {
          expect(open.has(event.index)).toBe(false)
          open.add(event.index)
          names.push(event.content_block?.name)

          break
        }
        case "content_block_delta": {
          expect(open.has(event.index)).toBe(true)
          argumentsByIndex.set(
            event.index,
            (argumentsByIndex.get(event.index) ?? "")
              + (event.delta?.partial_json ?? ""),
          )

          break
        }
        case "content_block_stop": {
          expect(open.delete(event.index)).toBe(true)

          break
        }
        // No default
      }
    }
    expect(names).toEqual(["lookup", "other"])
    expect(
      [...argumentsByIndex.values()].map(
        (value) => JSON.parse(value) as unknown,
      ),
    ).toEqual([{ a: 1 }, { b: 2 }])
    expect(open.size).toBe(0)
    expect(result.at(-1)?.type).toBe("message_stop")
  })

  test("native errors are forwarded once and unknown event types are retained", async () => {
    mockFetch(() =>
      sse(
        [
          { type: "future_event", payload: { retained: true } },
          {
            type: "error",
            error: { type: "overloaded_error", message: "Busy" },
          },
        ],
        true,
      ),
    )
    const result = await events(
      await request({ ...nativePayload, stream: true }),
    )
    expect(result.filter((event) => event.type === "error")).toHaveLength(1)
    expect(result.some((event) => event.type === "future_event")).toBe(true)
    expect(result.some((event) => event.type === "message_stop")).toBe(false)
  })
})
