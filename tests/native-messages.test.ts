import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { messageRoutes } from "../src/routes/messages/route"

const realFetch = globalThis.fetch

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

function makeModel(id: string, endpoints: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "Anthropic",
    version: id,
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {},
      supports: {},
    },
  }
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.copilotApiBaseUrl = undefined
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
  state.models = {
    object: "list",
    data: [makeModel("claude-haiku-4.5", ["/v1/messages"])],
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  state.models = undefined
})

describe("native Anthropic Messages routing", () => {
  test("passes native model requests and metadata through unchanged", async () => {
    let upstreamUrl = ""
    let upstreamHeaders = new Headers()
    let upstreamBody: Record<string, unknown> = {}
    globalThis.fetch = ((input, init) => {
      upstreamUrl = requestUrl(input)
      upstreamHeaders = new Headers(init?.headers)
      if (typeof init?.body !== "string")
        throw new TypeError("expected a JSON request body")
      upstreamBody = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4.5",
            content: [
              {
                type: "thinking",
                thinking: "internal",
                signature: "signed",
              },
              { type: "text", text: "OK" },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: 4,
              cache_read_input_tokens: 5,
            },
            copilot_usage: {
              token_details: [],
              total_nano_aiu: 99,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
    }) as typeof fetch

    const payload = {
      model: "claude-haiku-4.5",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 64,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }
    const response = await messageRoutes.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(upstreamUrl.endsWith("/v1/messages")).toBe(true)
    expect(upstreamHeaders.get("anthropic-version")).toBe("2023-06-01")
    expect(upstreamHeaders.get("anthropic-beta")).toBe(
      "prompt-caching-2024-07-31",
    )
    expect(upstreamBody).toEqual(payload)
    const body = (await response.json()) as {
      content: Array<{ type: string; thinking?: string; signature?: string }>
      copilot_usage: { total_nano_aiu: number }
    }
    expect(body.content[0]).toEqual({
      type: "thinking",
      thinking: "internal",
      signature: "signed",
    })
    expect(body.copilot_usage.total_nano_aiu).toBe(99)
  })

  test("preserves native streaming events including final Copilot usage", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-haiku-4.5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1},"copilot_usage":{"token_details":[],"total_nano_aiu":77}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )) as unknown as typeof fetch

    const response = await messageRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
        stream: true,
      }),
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: message_delta")
    expect(text).toContain('"total_nano_aiu":77')
    expect(text).toContain("event: message_stop")
  })

  test("keeps translation fallback for non-native models", async () => {
    state.models = {
      object: "list",
      data: [makeModel("gpt-4o", ["/chat/completions"])],
    }
    let upstreamUrl = ""
    globalThis.fetch = ((input) => {
      upstreamUrl = requestUrl(input)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chat_1",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "OK" },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
    }) as typeof fetch

    const response = await messageRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
      }),
    })
    const body = (await response.json()) as { type: string }

    expect(upstreamUrl.endsWith("/chat/completions")).toBe(true)
    expect(body.type).toBe("message")
  })
})
