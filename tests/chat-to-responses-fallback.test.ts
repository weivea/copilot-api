import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  recordResponsesOnlyModel,
  resetResponsesRouting,
} from "../src/lib/responses-routing"
import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

const realFetch = globalThis.fetch

beforeEach(() => {
  resetResponsesRouting()
  state.copilotToken = "test-token"
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createChatCompletions fallback to /responses", () => {
  test("when whitelist has model, calls /responses directly and returns chat-shaped response", async () => {
    recordResponsesOnlyModel("gpt-5.5")
    const calls: Array<string> = []
    globalThis.fetch = ((input: Request | string) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push(url)
      return Promise.resolve(
        jsonResponse({
          id: "resp_1",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "hi" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      )
    }) as typeof fetch

    const result = await createChatCompletions({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].endsWith("/responses")).toBe(true)
    if ("choices" in (result as object)) {
      expect((result as any).choices[0].message.content).toBe("hi")
      expect((result as any).object).toBe("chat.completion")
    } else {
      throw new Error("expected non-streaming chat completion shape")
    }
  })

  test("auto-fallback on unsupported_api_for_model error", async () => {
    const seen: Array<string> = []
    globalThis.fetch = ((input: Request | string) => {
      const url = typeof input === "string" ? input : (input as Request).url
      seen.push(url)
      if (url.endsWith("/chat/completions")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                message:
                  'model "gpt-5.5" is not accessible via the /chat/completions endpoint',
                code: "unsupported_api_for_model",
              },
            },
            400,
          ),
        )
      }
      return Promise.resolve(
        jsonResponse({
          id: "resp_2",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              id: "msg",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
      )
    }) as typeof fetch

    const result = await createChatCompletions({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(seen[0].endsWith("/chat/completions")).toBe(true)
    expect(seen[1].endsWith("/responses")).toBe(true)
    expect((result as any).choices[0].message.content).toBe("ok")
  })

  test("non-fallback errors are not retried", async () => {
    const seen: Array<string> = []
    globalThis.fetch = ((input: Request | string) => {
      const url = typeof input === "string" ? input : (input as Request).url
      seen.push(url)
      return Promise.resolve(
        jsonResponse(
          { error: { message: "rate limited", code: "rate_limit_exceeded" } },
          429,
        ),
      )
    }) as typeof fetch

    await expect(
      createChatCompletions({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0].endsWith("/chat/completions")).toBe(true)
  })
})
