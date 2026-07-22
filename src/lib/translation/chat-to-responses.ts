import consola from "consola"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesContentPart,
  ResponsesCompletedEvent,
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesTool,
} from "~/services/copilot/create-responses"

export function chatRequestToResponses(
  chat: ChatCompletionsPayload,
): ResponsesPayload {
  const systemTexts: Array<string> = []
  const input: Array<ResponsesInputItem> = []

  for (const msg of chat.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = stringifyContent(msg.content)
      if (text) systemTexts.push(text)
      continue
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: stringifyContent(msg.content),
      })
      continue
    }

    if (
      msg.role === "assistant"
      && msg.tool_calls
      && msg.tool_calls.length > 0
    ) {
      // If the assistant turn carries text alongside tool_calls, emit the text
      // first as a normal message item, then each tool_call as its own item.
      const text = stringifyContent(msg.content)
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "input_text", text }],
        })
      }
      for (const call of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
      }
      continue
    }

    input.push({
      type: "message",
      role: msg.role,
      content: messageContentToResponses(msg.content),
    })
  }

  const out: ResponsesPayload = {
    model: chat.model,
    input,
    store: false,
  }

  applyResponsesOptions(chat, out, systemTexts)

  return out
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

function applyResponsesOptions(
  chat: ChatCompletionsPayload,
  out: ResponsesPayload,
  systemTexts: Array<string>,
): void {
  if (systemTexts.length > 0) out.instructions = systemTexts.join("\n\n")
  if (isPresent(chat.stream)) out.stream = chat.stream
  applySamplingOptions(chat, out)
  applyToolOptions(chat, out)
  applyOutputOptions(chat, out)
}

function applySamplingOptions(
  chat: ChatCompletionsPayload,
  out: ResponsesPayload,
): void {
  if (isPresent(chat.temperature)) out.temperature = chat.temperature
  if (isPresent(chat.top_p)) out.top_p = chat.top_p
  if (isPresent(chat.frequency_penalty))
    out.frequency_penalty = chat.frequency_penalty
  if (isPresent(chat.presence_penalty))
    out.presence_penalty = chat.presence_penalty
  if (isPresent(chat.top_logprobs)) out.top_logprobs = chat.top_logprobs
  if (isPresent(chat.stop)) out.stop = chat.stop
  const maxOutputTokens = chat.max_completion_tokens ?? chat.max_tokens
  if (isPresent(maxOutputTokens)) out.max_output_tokens = maxOutputTokens
}

function applyToolOptions(
  chat: ChatCompletionsPayload,
  out: ResponsesPayload,
): void {
  if (isPresent(chat.parallel_tool_calls))
    out.parallel_tool_calls = chat.parallel_tool_calls
  if (isPresent(chat.tool_choice))
    out.tool_choice = translateToolChoice(chat.tool_choice)
  if (isPresent(chat.tools))
    out.tools = chat.tools.map((tool) => translateTool(tool))
}

function applyOutputOptions(
  chat: ChatCompletionsPayload,
  out: ResponsesPayload,
): void {
  if (isPresent(chat.user)) out.user = chat.user
  if (isPresent(chat.metadata)) out.metadata = chat.metadata
  if (isPresent(chat.service_tier)) out.service_tier = chat.service_tier
  if (isPresent(chat.reasoning_effort))
    out.reasoning = { effort: chat.reasoning_effort }
  if (isPresent(chat.response_format))
    out.text = { format: translateResponseFormat(chat.response_format) }
}

function translateResponseFormat(
  format: NonNullable<ChatCompletionsPayload["response_format"]>,
): NonNullable<NonNullable<ResponsesPayload["text"]>["format"]> {
  if (format.type !== "json_schema") return format
  return {
    type: "json_schema",
    ...format.json_schema,
  }
}

function stringifyContent(content: Message["content"]): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("")
}

function messageContentToResponses(
  content: Message["content"],
): Array<ResponsesContentPart> {
  if (content === null) return []
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }]
  }
  return content
    .map((part) => translatePart(part))
    .filter(Boolean) as Array<ResponsesContentPart>
}

function translatePart(part: ContentPart): ResponsesContentPart | null {
  if (part.type === "text") return { type: "input_text", text: part.text }
  return { type: "input_image", image_url: part.image_url.url }
}

function translateTool(tool: Tool): ResponsesTool {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }
}

function translateToolChoice(
  choice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): NonNullable<ResponsesPayload["tool_choice"]> {
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.function.name }
}

export function responsesToChatResponse(
  resp: ResponsesResponse,
): ChatCompletionResponse {
  const messageParts: Array<string> = []
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  for (const item of resp.output) {
    if (item.type === "message") {
      const m = item
      for (const part of m.content) {
        if (part.type === "output_text") messageParts.push(part.text)
      }
    } else if (item.type === "function_call") {
      const fc = item
      toolCalls.push({
        id: fc.call_id,
        type: "function",
        function: { name: fc.name, arguments: fc.arguments },
      })
    }
    // reasoning items intentionally dropped from chat-shaped output for now
  }

  const content = messageParts.length > 0 ? messageParts.join("") : null

  return {
    id: `chatcmpl-${resp.id}`,
    object: "chat.completion",
    created: resp.created_at,
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: responsesFinishReason(resp, toolCalls.length > 0),
      },
    ],
    usage: responsesUsageToChatUsage(resp),
    service_tier: resp.service_tier,
    copilot_usage: resp.copilot_usage,
    copilot_info_messages: resp.copilot_info_messages,
  }
}

function responsesFinishReason(
  response: ResponsesResponse,
  hasToolCalls: boolean,
): ChatCompletionResponse["choices"][number]["finish_reason"] {
  if (hasToolCalls) return "tool_calls"
  if (response.status === "incomplete") return "length"
  if (response.status === "failed") return "content_filter"
  return "stop"
}

function responsesUsageToChatUsage(
  response: ResponsesResponse,
): ChatCompletionResponse["usage"] {
  const usage = response.usage
  if (!usage) return undefined
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details && {
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details.cached_tokens ?? 0,
        ...(cacheWriteTokens !== undefined && {
          cache_creation_input_tokens: cacheWriteTokens,
        }),
      },
    }),
    ...(reasoningTokens !== undefined && {
      reasoning_tokens: reasoningTokens,
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    }),
  }
}

interface UpstreamSseEvent {
  event?: string
  data?: string
}

interface ChatChunkOut {
  data: string
}

interface CreatedPayload {
  response?: { id?: string }
}
interface TextDeltaPayload {
  delta?: string
}
interface FnArgsDeltaPayload {
  call_id?: string
  item_id?: string
  output_index?: number
  delta?: string
}
interface ItemAddedPayload {
  output_index?: number
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
  }
}
interface FailedPayload {
  response?: { error?: { message?: string } }
  error?: { message?: string }
}

// Maps Copilot /responses SSE events to OpenAI-style chat.completion.chunk SSE.
// Yields objects shaped like { data: string } to match `events()` from
// fetch-event-stream so callers (chat-completions handler) can pipe them through
// without changes. Always ends with a `{ data: "[DONE]" }` sentinel.
export async function* responsesStreamToChatStream(
  upstream: AsyncIterable<UpstreamSseEvent>,
  model: string,
): AsyncGenerator<ChatChunkOut> {
  let id = `chatcmpl-stream-${Date.now()}`
  let emittedRole = false
  let sawToolCall = false
  // call_id → index assignment so deltas can be merged client-side
  const callIndex = new Map<string, number>()
  const outputIndexToCallIndex = new Map<number, number>()
  let nextIndex = 0

  const baseChunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) =>
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    })

  for await (const evt of upstream) {
    if (!evt.event || evt.data === undefined) continue
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(evt.data) as Record<string, unknown>
    } catch {
      continue
    }

    switch (evt.event) {
      case "response.created": {
        const p = payload as CreatedPayload
        if (p.response?.id) id = `chatcmpl-${p.response.id}`
        // Emit a leading chunk with role:"assistant" so chat clients
        // can latch onto the assistant turn before content arrives.
        emittedRole = true
        yield { data: baseChunk({ role: "assistant" }) }
        break
      }

      case "response.output_text.delta": {
        const delta = (payload as TextDeltaPayload).delta
        if (typeof delta !== "string") break
        if (!emittedRole) {
          emittedRole = true
          yield { data: baseChunk({ role: "assistant", content: delta }) }
        } else {
          yield { data: baseChunk({ content: delta }) }
        }
        break
      }

      case "response.output_item.added": {
        const item = (payload as ItemAddedPayload).item
        if (item?.type === "function_call" && item.call_id) {
          sawToolCall = true
          const idx = nextIndex++
          callIndex.set(item.call_id, idx)
          if (item.id) callIndex.set(item.id, idx)
          const outputIndex = (payload as ItemAddedPayload).output_index
          if (outputIndex !== undefined)
            outputIndexToCallIndex.set(outputIndex, idx)
          yield {
            data: baseChunk({
              tool_calls: [
                {
                  index: idx,
                  id: item.call_id,
                  type: "function",
                  function: { name: item.name ?? "", arguments: "" },
                },
              ],
            }),
          }
        }
        break
      }

      case "response.function_call_arguments.delta": {
        const p = payload as FnArgsDeltaPayload
        const delta = p.delta
        if (typeof delta !== "string") break
        const idx =
          (p.call_id ? callIndex.get(p.call_id) : undefined)
          ?? (p.item_id ? callIndex.get(p.item_id) : undefined)
          ?? (p.output_index === undefined ?
            undefined
          : outputIndexToCallIndex.get(p.output_index))
          ?? 0
        sawToolCall = true
        yield {
          data: baseChunk({
            tool_calls: [
              {
                index: idx,
                function: { arguments: delta },
              },
            ],
          }),
        }
        break
      }

      case "response.completed":
      case "response.incomplete": {
        const completed = payload as ResponsesCompletedEvent
        const response = completed.response
        const usage = response?.usage
        const incomplete =
          evt.event === "response.incomplete"
          || response?.status === "incomplete"
        let finishReason = "stop"
        if (sawToolCall) finishReason = "tool_calls"
        else if (incomplete) finishReason = "length"
        const finalChoices = [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
            logprobs: null,
          },
        ]
        const final = JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: finalChoices,
          usage:
            usage ?
              {
                prompt_tokens: usage.input_tokens,
                completion_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
                ...(usage.input_tokens_details && {
                  prompt_tokens_details: {
                    cached_tokens:
                      usage.input_tokens_details.cached_tokens ?? 0,
                    ...(usage.input_tokens_details.cache_write_tokens
                      !== undefined && {
                      cache_creation_input_tokens:
                        usage.input_tokens_details.cache_write_tokens,
                    }),
                  },
                }),
                ...(usage.output_tokens_details?.reasoning_tokens
                  !== undefined && {
                  reasoning_tokens:
                    usage.output_tokens_details.reasoning_tokens,
                  completion_tokens_details: {
                    reasoning_tokens:
                      usage.output_tokens_details.reasoning_tokens,
                  },
                }),
              }
            : undefined,
          copilot_usage: completed.copilot_usage ?? response?.copilot_usage,
          copilot_info_messages:
            completed.copilot_info_messages ?? response?.copilot_info_messages,
        })
        yield { data: final }
        yield { data: "[DONE]" }
        return
      }

      case "response.failed":
      case "response.error": {
        const p = payload as FailedPayload
        const message =
          p.response?.error?.message
          ?? p.error?.message
          ?? "responses upstream error"
        yield {
          data: JSON.stringify({
            error: { message, type: "upstream_error" },
          }),
        }
        yield { data: "[DONE]" }
        return
      }

      default: {
        // Silently ignore other event types (in_progress, content_part.*, etc.)
        consola.debug("responsesStreamToChatStream: ignoring event", evt.event)
      }
    }
  }

  // Upstream ended without `response.completed` — close gracefully.
  yield {
    data: baseChunk({}, sawToolCall ? "tool_calls" : "stop"),
  }
  yield { data: "[DONE]" }
}
