import { describe, test, expect } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import {
  chatRequestToResponses,
  responsesToChatResponse,
  responsesStreamToChatStream,
} from "../src/lib/translation/chat-to-responses"
import type { ResponsesResponse } from "../src/services/copilot/create-responses"

async function* fromArray<T>(items: Array<T>): AsyncGenerator<T> {
  for (const it of items) yield it
}

async function collect(
  it: AsyncIterable<{ data?: string }>,
): Promise<Array<string>> {
  const out: Array<string> = []
  for await (const chunk of it) {
    if (chunk.data !== undefined) out.push(chunk.data)
  }
  return out
}

describe("chatRequestToResponses", () => {
  test("user-only message becomes input array with input_text", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    }
    const out = chatRequestToResponses(chat)
    expect(out.model).toBe("gpt-5.5")
    expect(out.store).toBe(false)
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ])
    expect(out.instructions).toBeUndefined()
  })

  test("system messages become top-level instructions, joined", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "be terse" },
        { role: "system", content: "use english" },
        { role: "user", content: "hi" },
      ],
    }
    const out = chatRequestToResponses(chat)
    expect(out.instructions).toBe("be terse\n\nuse english")
    // system messages are stripped from input
    expect(Array.isArray(out.input)).toBe(true)
    expect(
      (out.input as Array<{ role: string }>).every((i) => i.role !== "system"),
    ).toBe(true)
  })

  test("assistant tool_calls become function_call input items", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    }
    const out = chatRequestToResponses(chat)
    const items = out.input as unknown as Array<Record<string, unknown>>
    expect(items[1]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"NYC"}',
    })
    expect(items[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "sunny",
    })
  })

  test("image_url content becomes input_image", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aaa" },
            },
          ],
        },
      ],
    }
    const out = chatRequestToResponses(chat)
    const items = out.input as Array<{
      content: Array<{ type: string; text?: string; image_url?: string }>
    }>
    expect(items[0].content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: "data:image/png;base64,aaa" },
    ])
  })

  test("max_tokens is renamed to max_output_tokens", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
    }
    const out = chatRequestToResponses(chat)
    expect(out.max_output_tokens).toBe(256)
    expect(
      (out as unknown as Record<string, unknown>).max_tokens,
    ).toBeUndefined()
  })

  test("tools are flattened from {function:{}} to top-level fields", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }
    const out = chatRequestToResponses(chat)
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "weather",
        parameters: { type: "object", properties: {} },
      },
    ])
  })

  test("stream + temperature + top_p + stop pass through", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
      stop: ["END"],
    }
    const out = chatRequestToResponses(chat)
    expect(out.stream).toBe(true)
    expect(out.temperature).toBe(0.5)
    expect(out.top_p).toBe(0.9)
    expect(out.stop).toEqual(["END"])
  })
})

describe("responsesToChatResponse", () => {
  test("plain message output becomes single choice with content string", () => {
    const resp: ResponsesResponse = {
      id: "resp_1",
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          id: "msg_1",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "hello " },
            { type: "output_text", text: "world" },
          ],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    }
    const out = responsesToChatResponse(resp)
    expect(out.id.startsWith("chatcmpl-")).toBe(true)
    expect(out.object).toBe("chat.completion")
    expect(out.model).toBe("gpt-5.5")
    expect(out.choices).toHaveLength(1)
    expect(out.choices[0].finish_reason).toBe("stop")
    expect(out.choices[0].message.role).toBe("assistant")
    expect(out.choices[0].message.content).toBe("hello world")
    expect(out.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    })
  })

  test("function_call output becomes message.tool_calls", () => {
    const resp: ResponsesResponse = {
      id: "resp_2",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
          status: "completed",
        },
      ],
    }
    const out = responsesToChatResponse(resp)
    expect(out.choices[0].finish_reason).toBe("tool_calls")
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
    ])
    expect(out.choices[0].message.content).toBeNull()
  })

  test("incomplete status maps to length finish_reason", () => {
    const resp: ResponsesResponse = {
      id: "resp_3",
      object: "response",
      created_at: 1,
      status: "incomplete",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          id: "msg",
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "partial" }],
        },
      ],
      incomplete_details: { reason: "max_output_tokens" },
    }
    const out = responsesToChatResponse(resp)
    expect(out.choices[0].finish_reason).toBe("length")
  })
})

describe("responsesStreamToChatStream", () => {
  test("translates text deltas, leading role chunk, and final stop", async () => {
    const upstream = fromArray([
      { event: "response.created", data: JSON.stringify({ response: { id: "r1", model: "gpt-5.5" } }) },
      { event: "response.output_text.delta", data: JSON.stringify({ delta: "hi " }) },
      { event: "response.output_text.delta", data: JSON.stringify({ delta: "there" }) },
      { event: "response.completed", data: JSON.stringify({ response: { id: "r1", model: "gpt-5.5", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }) },
    ])

    const out = await collect(responsesStreamToChatStream(upstream, "gpt-5.5"))

    // Last chunk must be [DONE]
    expect(out[out.length - 1]).toBe("[DONE]")
    // First content chunk should carry role assistant
    const parsed = out.slice(0, -1).map((d) => JSON.parse(d) as Record<string, any>)
    expect(parsed[0].choices[0].delta.role).toBe("assistant")
    // Concatenated content equals "hi there"
    const concatenated = parsed
      .map((c) => c.choices[0].delta.content as string | undefined)
      .filter((x) => typeof x === "string")
      .join("")
    expect(concatenated).toBe("hi there")
    // A chunk with finish_reason "stop" must exist
    expect(parsed.some((c) => c.choices[0].finish_reason === "stop")).toBe(true)
    // A chunk must carry usage
    expect(
      parsed.some(
        (c) =>
          c.usage
          && c.usage.prompt_tokens === 1
          && c.usage.completion_tokens === 2,
      ),
    ).toBe(true)
  })

  test("translates function_call_arguments deltas to tool_call deltas", async () => {
    const upstream = fromArray([
      { event: "response.created", data: JSON.stringify({ response: { id: "r2" } }) },
      {
        event: "response.output_item.added",
        data: JSON.stringify({
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
            arguments: "",
            status: "in_progress",
          },
        }),
      },
      {
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({ output_index: 0, call_id: "call_1", delta: '{"city":' }),
      },
      {
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({ output_index: 0, call_id: "call_1", delta: '"NYC"}' }),
      },
      { event: "response.completed", data: JSON.stringify({ response: { id: "r2" } }) },
    ])

    const out = await collect(responsesStreamToChatStream(upstream, "gpt-5.5"))
    const parsed = out.slice(0, -1).map((d) => JSON.parse(d) as Record<string, any>)
    // Find the chunk that introduces the tool call (carries name + id)
    const introChunk = parsed.find(
      (c) => c.choices[0].delta.tool_calls?.[0]?.function?.name === "get_weather",
    )
    expect(introChunk).toBeDefined()
    expect(introChunk!.choices[0].delta.tool_calls[0].id).toBe("call_1")
    expect(introChunk!.choices[0].delta.tool_calls[0].index).toBe(0)
    // Concatenated arguments equal the full JSON
    const args = parsed
      .map((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments as string | undefined)
      .filter((x) => typeof x === "string")
      .join("")
    expect(args).toBe('{"city":"NYC"}')
    // Final chunk should have finish_reason tool_calls
    expect(
      parsed.some((c) => c.choices[0].finish_reason === "tool_calls"),
    ).toBe(true)
  })

  test("response.failed surfaces an error chunk and DONE", async () => {
    const upstream = fromArray([
      { event: "response.created", data: JSON.stringify({ response: { id: "r3" } }) },
      {
        event: "response.failed",
        data: JSON.stringify({ response: { id: "r3", error: { message: "boom" } } }),
      },
    ])
    const out = await collect(responsesStreamToChatStream(upstream, "gpt-5.5"))
    expect(out[out.length - 1]).toBe("[DONE]")
    const errorChunk = out
      .slice(0, -1)
      .map((d) => JSON.parse(d) as Record<string, any>)
      .find((c) => c.error)
    expect(errorChunk).toBeDefined()
    expect(errorChunk!.error.message).toBe("boom")
  })
})
