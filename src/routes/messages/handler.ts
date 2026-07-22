import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { recordUsage, deferUsage, flushUsage } from "~/lib/usage-recorder"
import { formatErrorWithCause } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  createMessages,
  type NativeMessagesStreamEvent,
} from "~/services/copilot/create-messages"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  buildCopilotInfoEvent,
  translateChunkToAnthropicEvents,
} from "./stream-translation"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (supportsNativeMessages(anthropicPayload.model)) {
    return handleNativeCompletion(c, anthropicPayload)
  }

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  // Single AbortController governs the upstream fetch. Aborted on client
  // disconnect or in finally so we never leave the upstream socket dangling
  // (which surfaces back as "socket closed unexpectedly" on subsequent ops).
  const upstreamController = new AbortController()
  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(openAIPayload, {
      signal: upstreamController.signal,
    })
  } catch (error) {
    consola.error(
      "Upstream chat completions failed:",
      formatErrorWithCause(error),
    )
    throw error
  }

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    captureInfoMessages(response, {
      endpoint: "/v1/messages",
      model: openAIPayload.model,
    })
    recordUsage(c, {
      model: openAIPayload.model,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      costNanoAiu: pickCostNanoAiu(response),
    })
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  const usage = {
    prompt: 0,
    completion: 0,
    total: 0,
    cached: 0,
    cacheCreation: 0,
  }
  deferUsage(c)
  return streamSSE(
    c,
    (stream) =>
      runAnthropicStream(stream, {
        response,
        usage,
        c,
        model: openAIPayload.model,
        upstreamController,
      }),
    (error, stream) => handleAnthropicStreamFatalError(error, stream),
  )
}

function supportsNativeMessages(model: string): boolean {
  return (
    state.models?.data
      .find((candidate) => candidate.id === model)
      ?.supported_endpoints?.includes("/v1/messages") ?? false
  )
}

function isNativeAgentCall(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      message.role === "assistant"
      || (Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result")),
  )
}

function totalNativeInputTokens(
  usage: Partial<AnthropicResponse["usage"]> | undefined,
): number {
  if (!usage) return 0
  return (
    (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
  )
}

async function handleNativeCompletion(
  c: Context,
  payload: AnthropicMessagesPayload,
) {
  const upstreamController = new AbortController()
  let upstream: Awaited<ReturnType<typeof createMessages<AnthropicResponse>>>
  try {
    upstream = await createMessages<AnthropicResponse>(payload, {
      signal: upstreamController.signal,
      stream: payload.stream === true,
      initiator: isNativeAgentCall(payload) ? "agent" : "user",
      anthropicVersion: c.req.header("anthropic-version"),
      anthropicBeta: c.req.header("anthropic-beta"),
    })
  } catch (error) {
    consola.error(
      "Upstream native messages failed:",
      formatErrorWithCause(error),
    )
    throw error
  }

  if (payload.stream !== true) {
    const response = upstream as AnthropicResponse
    captureInfoMessages(response, {
      endpoint: "/v1/messages",
      model: response.model,
    })
    const promptTokens = totalNativeInputTokens(response.usage)
    recordUsage(c, {
      model: response.model,
      promptTokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: promptTokens + response.usage.output_tokens,
      costNanoAiu: pickCostNanoAiu(response),
    })
    return c.json(response)
  }

  deferUsage(c)
  return streamSSE(
    c,
    (stream) =>
      pipeNativeAnthropicStream(stream, {
        response: upstream as AsyncIterable<NativeMessagesStreamEvent>,
        c,
        requestedModel: payload.model,
        upstreamController,
      }),
    (error) => {
      consola.error(
        "streamSSE onError (native messages):",
        formatErrorWithCause(error),
      )
      return Promise.resolve()
    },
  )
}

interface NativeStreamUsage {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

interface NativeMessageStreamPayload {
  message?: Partial<AnthropicResponse>
  usage?: Partial<AnthropicResponse["usage"]>
  copilot_usage?: AnthropicResponse["copilot_usage"]
  copilot_info_messages?: AnthropicResponse["copilot_info_messages"]
}

function captureNativeUsage(
  source: Partial<AnthropicResponse["usage"]> | undefined,
  target: NativeStreamUsage,
): void {
  if (!source) return
  if (source.input_tokens !== undefined)
    target.input = Math.max(target.input, source.input_tokens)
  if (source.output_tokens !== undefined)
    target.output = Math.max(target.output, source.output_tokens)
  if (source.cache_creation_input_tokens !== undefined)
    target.cacheCreation = Math.max(
      target.cacheCreation,
      source.cache_creation_input_tokens,
    )
  if (source.cache_read_input_tokens !== undefined)
    target.cacheRead = Math.max(
      target.cacheRead,
      source.cache_read_input_tokens,
    )
}

interface NativeStreamContext {
  response: AsyncIterable<NativeMessagesStreamEvent>
  c: Context
  requestedModel: string
  upstreamController: AbortController
}

interface NativeStreamMeta {
  model: string
  costNanoAiu: number | null
}

function captureNativeEvent(
  data: string,
  usage: NativeStreamUsage,
  meta: NativeStreamMeta,
): void {
  let parsed: NativeMessageStreamPayload
  try {
    parsed = JSON.parse(data) as NativeMessageStreamPayload
  } catch {
    // Metadata capture is best-effort; the original event is still forwarded.
    return
  }

  if (parsed.message?.model) meta.model = parsed.message.model
  captureNativeUsage(parsed.message?.usage, usage)
  captureNativeUsage(parsed.usage, usage)
  captureInfoMessages(parsed, {
    endpoint: "/v1/messages",
    model: meta.model,
  })
  captureInfoMessages(parsed.message, {
    endpoint: "/v1/messages",
    model: meta.model,
  })
  meta.costNanoAiu =
    pickCostNanoAiu(parsed)
    ?? pickCostNanoAiu(parsed.message)
    ?? meta.costNanoAiu
}

async function pipeNativeAnthropicStream(
  stream: SSEStreamingApi,
  ctx: NativeStreamContext,
): Promise<void> {
  const { response, c, requestedModel, upstreamController } = ctx
  const usage: NativeStreamUsage = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  }
  const meta: NativeStreamMeta = {
    model: requestedModel,
    costNanoAiu: null,
  }
  const abortState = { aborted: false }

  stream.onAbort(() => {
    abortState.aborted = true
    upstreamController.abort()
  })

  const pingInterval = setInterval(() => {
    if (abortState.aborted || stream.closed) return
    stream
      .writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) })
      .catch(() => {
        /* stream may be closing */
      })
  }, 10_000)

  try {
    for await (const rawEvent of response) {
      if (abortState.aborted) break
      if (rawEvent.data) captureNativeEvent(rawEvent.data, usage, meta)
      if (rawEvent.data !== undefined) {
        await stream.writeSSE({
          data: rawEvent.data,
          event: rawEvent.event,
          id: rawEvent.id === undefined ? undefined : String(rawEvent.id),
          retry: rawEvent.retry,
        })
      }
    }
  } catch (error) {
    consola.error(
      "Upstream native messages stream failed:",
      formatErrorWithCause(error),
    )
    if (!abortState.aborted && !stream.closed) {
      const message = error instanceof Error ? error.message : String(error)
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          type: "error",
          error: { type: "api_error", message },
        }),
      })
    }
  } finally {
    clearInterval(pingInterval)
    upstreamController.abort()
    const promptTokens = usage.input + usage.cacheCreation + usage.cacheRead
    const totalTokens = promptTokens + usage.output
    recordUsage(c, {
      model: meta.model,
      promptTokens: promptTokens || null,
      completionTokens: usage.output || null,
      totalTokens: totalTokens || null,
      costNanoAiu: meta.costNanoAiu,
    })
    flushUsage(c)
  }
}

interface RunAnthropicStreamCtx {
  response: AsyncIterable<{ data?: string }>
  usage: {
    prompt: number
    completion: number
    total: number
    cached: number
    cacheCreation: number
  }
  c: Context
  model: string
  upstreamController: AbortController
}

interface StreamMeta {
  state: AnthropicStreamState
  cost: number | null
}

function captureChunkMetadata(
  chunk: ChatCompletionChunk,
  meta: StreamMeta,
  model: string,
): void {
  if (chunk.copilot_info_messages?.length) {
    meta.state.copilotInfoMessages = chunk.copilot_info_messages
    captureInfoMessages(chunk, { endpoint: "/v1/messages", model })
  }
  const cc = pickCostNanoAiu(chunk)
  if (cc !== null) meta.cost = cc
}

async function emitCopilotInfoIfAny(
  state: AnthropicStreamState,
  writeSafe: (event: string, data: unknown) => Promise<void>,
): Promise<void> {
  const copilotInfo = buildCopilotInfoEvent(state)
  if (copilotInfo) {
    await writeSafe(copilotInfo.type, copilotInfo)
  }
}

async function runAnthropicStream(
  stream: SSEStreamingApi,
  ctx: RunAnthropicStreamCtx,
): Promise<void> {
  const { response, usage, c, model, upstreamController } = ctx
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  const meta: StreamMeta = { state: streamState, cost: null }

  const abortState = { aborted: false }
  // Idempotency guard: both the catch path and Hono's onError can call the
  // finalizer. Only the first one is allowed to write end-of-stream events.
  const finalizerState = { ran: false }
  stream.onAbort(() => {
    abortState.aborted = true
    consola.debug("Client aborted Anthropic stream")
    // Cancel upstream immediately so we don't keep an orphan socket open.
    upstreamController.abort()
  })

  // Periodic SSE ping to keep intermediaries (and the Anthropic SDK's own
  // streaming idle timer) from closing the socket while upstream is slow
  // to produce the first / next token. Send one immediately so the client
  // observes bytes within its idle window even when upstream "thinking"
  // delays the first real chunk by 10+ seconds; then refresh every 10s,
  // which stays comfortably under the shortest idle timeout we've observed
  // in the wild (~16s on the Anthropic SDK side).
  const sendPing = () => {
    if (abortState.aborted || stream.closed) return
    stream
      .writeSSE({
        event: "ping",
        data: JSON.stringify({ type: "ping" }),
      })
      .catch(() => {
        /* ignore: stream may be closing */
      })
  }
  // Fire-and-forget: writeSSE returns a promise, but we don't need to
  // await it before entering the read loop — the next iteration will
  // serialize naturally on the same stream.
  sendPing()
  const pingInterval = setInterval(sendPing, 10_000)

  try {
    for await (const rawEvent of response) {
      if (abortState.aborted) break
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      if (chunk.usage) {
        const u = chunk.usage
        usage.prompt = u.prompt_tokens ?? usage.prompt
        usage.completion = u.completion_tokens ?? usage.completion
        usage.total = u.total_tokens ?? usage.total
        usage.cached = u.prompt_tokens_details?.cached_tokens ?? usage.cached
        usage.cacheCreation =
          u.prompt_tokens_details?.cache_creation_input_tokens
          ?? usage.cacheCreation
      }
      captureChunkMetadata(chunk, meta, model)
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  } catch (error) {
    consola.error(
      "Upstream stream error, closing gracefully:",
      formatErrorWithCause(error),
    )
    if (!abortState.aborted) {
      await emitAnthropicStreamError(stream, {
        streamState,
        error,
        finalizerState,
      })
    }
  } finally {
    clearInterval(pingInterval)
    // Make sure the upstream socket is released even on the happy path —
    // calling abort() after the body is fully consumed is a no-op.
    upstreamController.abort()

    // Emit the closing message_delta + message_stop with the AGGREGATED
    // usage we collected across all chunks. This guarantees the client sees
    // the final input/output token counts even when upstream puts `usage`
    // in a chunk separate from `finish_reason`.
    if (
      !abortState.aborted
      && !stream.closed
      && !streamState.finalEventsSent
      && !finalizerState.ran
    ) {
      streamState.finalEventsSent = true
      const writeSafe = async (event: string, data: unknown) => {
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) })
        } catch {
          /* ignore */
        }
      }
      if (streamState.contentBlockOpen) {
        await writeSafe("content_block_stop", {
          type: "content_block_stop",
          index: streamState.contentBlockIndex,
        })
        streamState.contentBlockOpen = false
      }
      await emitCopilotInfoIfAny(streamState, writeSafe)
      const inputTokens = Math.max(
        0,
        usage.prompt - usage.cached - usage.cacheCreation,
      )
      await writeSafe("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(
            (streamState.finishReason ?? "stop") as
              | "stop"
              | "length"
              | "tool_calls"
              | "content_filter",
          ),
          stop_sequence: null,
        },
        usage: {
          input_tokens: inputTokens,
          output_tokens: usage.completion,
          ...(usage.cached > 0 && { cache_read_input_tokens: usage.cached }),
          ...(usage.cacheCreation > 0 && {
            cache_creation_input_tokens: usage.cacheCreation,
          }),
        },
      })
      await writeSafe("message_stop", { type: "message_stop" })
    }

    recordUsage(c, {
      model,
      promptTokens: usage.prompt || null,
      completionTokens: usage.completion || null,
      totalTokens: usage.total || null,
      costNanoAiu: meta.cost,
    })
    flushUsage(c)
  }
}

async function handleAnthropicStreamFatalError(
  error: Error,
  stream: SSEStreamingApi,
): Promise<void> {
  consola.error("streamSSE onError:", formatErrorWithCause(error))
  try {
    await emitAnthropicStreamError(stream, {
      streamState: {
        messageStartSent: true,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      },
      error,
      // Fresh guard — onError fires only when the inner runner already threw
      // past its own try/catch, so it's safe to attempt one final write.
      finalizerState: { ran: false },
    })
  } catch {
    /* ignore */
  }
}

interface EmitErrorCtx {
  streamState: AnthropicStreamState
  error: unknown
  finalizerState: { ran: boolean }
}

async function emitAnthropicStreamError(
  stream: SSEStreamingApi,
  ctx: EmitErrorCtx,
): Promise<void> {
  const { streamState, error, finalizerState } = ctx
  if (finalizerState.ran) return
  finalizerState.ran = true
  // Block the happy-path finalizer in handler from also emitting close events.
  streamState.finalEventsSent = true
  if (stream.closed) return
  const message = error instanceof Error ? error.message : String(error)

  const writeSafe = async (event: string, data: unknown) => {
    try {
      await stream.writeSSE({ event, data: JSON.stringify(data) })
    } catch {
      /* ignore */
    }
  }

  // If a content block is still open, close it so the client state machine
  // doesn't get stuck.
  if (streamState.contentBlockOpen) {
    await writeSafe("content_block_stop", {
      type: "content_block_stop",
      index: streamState.contentBlockIndex,
    })
  }

  await writeSafe("error", {
    type: "error",
    error: { type: "api_error", message },
  })

  // Always end with a proper message_stop so Claude Code finishes the turn
  // instead of reporting "socket closed unexpectedly".
  await writeSafe("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  })
  await writeSafe("message_stop", { type: "message_stop" })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
