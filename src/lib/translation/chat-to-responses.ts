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

import { HTTPError } from "~/lib/error"

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
          content: [{ type: "output_text", text }],
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
      content: messageContentToResponses(msg.content, msg.role === "assistant"),
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
  if (isPresent(chat.store)) out.store = chat.store
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
  assistant = false,
): Array<ResponsesContentPart> {
  if (content === null) return []
  if (typeof content === "string") {
    return [{ type: assistant ? "output_text" : "input_text", text: content }]
  }
  return content
    .map((part) => translatePart(part, assistant))
    .filter(Boolean) as Array<ResponsesContentPart>
}

function translatePart(
  part: ContentPart,
  assistant: boolean,
): ResponsesContentPart | null {
  if (part.type === "text")
    return { type: assistant ? "output_text" : "input_text", text: part.text }
  return {
    type: "input_image",
    image_url: part.image_url.url,
    ...(part.image_url.detail && { detail: part.image_url.detail }),
  }
}

function translateTool(tool: Tool): ResponsesTool {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    ...(tool.function.strict !== undefined && { strict: tool.function.strict }),
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
  if (resp.status === "failed" || resp.error) {
    throw new HTTPError(
      "Responses upstream failed",
      new Response(null, { status: 502 }),
      JSON.stringify({
        error: resp.error ?? { message: "Responses upstream failed" },
      }),
    )
  }
  const messageParts: Array<string> = []
  const refusals: Array<string> = []
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
        if (part.type === "refusal") refusals.push(part.refusal)
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
          ...(refusals.length > 0 && { refusal: refusals.join("") }),
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
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ?
        "content_filter"
      : "length"
  }
  if (hasToolCalls) return "tool_calls"
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

interface StreamToolState {
  callIndex: Map<string, number>
  outputIndexToCallIndex: Map<number, number>
  nextIndex: number
  sawToolCall: boolean
}

function toolAddedDelta(payload: ItemAddedPayload, state: StreamToolState) {
  const item = payload.item
  if (item?.type !== "function_call" || !item.call_id) return null
  state.sawToolCall = true
  const index = state.nextIndex++
  state.callIndex.set(item.call_id, index)
  if (item.id) state.callIndex.set(item.id, index)
  if (payload.output_index !== undefined)
    state.outputIndexToCallIndex.set(payload.output_index, index)
  return {
    tool_calls: [
      {
        index,
        id: item.call_id,
        type: "function",
        function: { name: item.name ?? "", arguments: "" },
      },
    ],
  }
}

function toolArgumentsDelta(
  payload: FnArgsDeltaPayload,
  state: StreamToolState,
) {
  if (typeof payload.delta !== "string") return null
  const index =
    (payload.call_id ? state.callIndex.get(payload.call_id) : undefined)
    ?? (payload.item_id ? state.callIndex.get(payload.item_id) : undefined)
    ?? (payload.output_index === undefined ?
      undefined
    : state.outputIndexToCallIndex.get(payload.output_index))
  if (index === undefined)
    throw new Error("Received tool arguments without a matching tool call")
  state.sawToolCall = true
  return { tool_calls: [{ index, function: { arguments: payload.delta } }] }
}

function finalStreamFields(completed: ResponsesCompletedEvent) {
  const response = completed.response
  return {
    usage: response ? responsesUsageToChatUsage(response) : undefined,
    copilot_usage: completed.copilot_usage ?? response?.copilot_usage,
    copilot_info_messages:
      completed.copilot_info_messages ?? response?.copilot_info_messages,
  }
}

function streamError(payload: Record<string, unknown>) {
  const failed = payload as FailedPayload
  const message =
    failed.response?.error?.message
    ?? failed.error?.message
    ?? (typeof payload.message === "string" ? payload.message : undefined)
    ?? "responses upstream error"
  return { error: { message, type: "upstream_error", param: null, code: null } }
}

function streamFinishReason(
  event: string,
  response: ResponsesResponse | undefined,
  hasTools: boolean,
) {
  if (event === "response.incomplete" || response?.status === "incomplete") {
    return response?.incomplete_details?.reason === "content_filter" ?
        "content_filter"
      : "length"
  }
  if (hasTools) return "tool_calls"
  return "stop"
}

function eventDelta(
  event: string,
  payload: Record<string, unknown>,
  state: StreamToolState,
): Record<string, unknown> | null {
  if (event === "response.output_text.delta") {
    const delta = (payload as TextDeltaPayload).delta
    return typeof delta === "string" ? { content: delta } : null
  }
  if (event === "response.refusal.delta") {
    return typeof payload.delta === "string" ? { refusal: payload.delta } : null
  }
  if (event === "response.output_item.added")
    return toolAddedDelta(payload as ItemAddedPayload, state)
  if (event === "response.function_call_arguments.delta")
    return toolArgumentsDelta(payload as FnArgsDeltaPayload, state)
  consola.debug("responsesStreamToChatStream: ignoring event", event)
  return null
}

// Maps Copilot /responses SSE events to OpenAI-style chat.completion.chunk SSE.
// Yields objects shaped like { data: string } to match `events()` from
// fetch-event-stream so callers (chat-completions handler) can pipe them through
// without changes. Truncated streams throw instead of inventing a completion.
export async function* responsesStreamToChatStream(
  upstream: AsyncIterable<UpstreamSseEvent>,
  model: string,
): AsyncGenerator<ChatChunkOut> {
  let id = `chatcmpl-stream-${Date.now()}`
  let emittedRole = false
  const tools: StreamToolState = {
    callIndex: new Map(),
    outputIndexToCallIndex: new Map(),
    nextIndex: 0,
    sawToolCall: false,
  }
  const created = Math.floor(Date.now() / 1000)

  const baseChunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) =>
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
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

      case "response.completed":
      case "response.incomplete": {
        const completed = payload as ResponsesCompletedEvent
        const finishReason = streamFinishReason(
          evt.event,
          completed.response,
          tools.sawToolCall,
        )
        const chunk = JSON.parse(baseChunk({}, finishReason)) as Record<
          string,
          unknown
        >
        yield {
          data: JSON.stringify({ ...chunk, ...finalStreamFields(completed) }),
        }
        yield { data: "[DONE]" }
        return
      }

      case "response.failed":
      case "error":
      case "response.error": {
        yield { data: JSON.stringify(streamError(payload)) }
        yield { data: "[DONE]" }
        return
      }

      default: {
        const delta = eventDelta(evt.event, payload, tools)
        if (!delta) break
        if (!emittedRole) {
          emittedRole = true
          yield { data: baseChunk({ role: "assistant" }) }
        }
        yield { data: baseChunk(delta) }
      }
    }
  }

  throw new Error("Upstream Responses stream ended before a terminal event")
}
