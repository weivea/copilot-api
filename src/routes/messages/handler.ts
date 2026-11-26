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
import {
  normalizeAnthropicUsage,
  normalizeChatUsage,
  type AnthropicUsageLike,
  type ChatUsageLike,
} from "~/lib/usage-normalizer"
import {
  deferUsage,
  flushUsage,
  recordNormalizedUsage,
} from "~/lib/usage-recorder"
import { cacheModels, formatErrorWithCause } from "~/lib/utils"
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
  type AnthropicResponse,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  forwardMessagesHeaders,
  readMessagesPayload,
  resolveMessagesModel,
  supportsNativeMessages,
  translatedMessagesPayload,
  type NativeMessagesPayload,
} from "./request"
import {
  buildCopilotInfoEvent,
  translateChunkToAnthropicEvents,
} from "./stream-translation"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await readMessagesPayload(c)
  if (!state.models) await cacheModels()
  anthropicPayload.model = resolveMessagesModel(anthropicPayload.model)
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (supportsNativeMessages(anthropicPayload.model)) {
    return handleNativeCompletion(c, anthropicPayload)
  }

  const openAIPayload = translateToOpenAI(
    translatedMessagesPayload(anthropicPayload),
  )
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
      signal: AbortSignal.any([c.req.raw.signal, upstreamController.signal]),
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
    recordNormalizedUsage(c, {
      model: openAIPayload.model,
      usage: normalizeChatUsage(response.usage, {
        usageComplete: response.usage !== undefined,
      }),
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
        rawUsage: undefined,
        c,
        model: openAIPayload.model,
        upstreamController,
      }),
    (error, stream) => handleAnthropicStreamFatalError(error, stream),
  )
}

function isNativeAgentCall(payload: NativeMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      message.role === "assistant"
      || (Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result")),
  )
}

async function handleNativeCompletion(
  c: Context,
  payload: NativeMessagesPayload,
) {
  const upstreamController = new AbortController()
  let upstream: Awaited<ReturnType<typeof createMessages<AnthropicResponse>>>
  try {
    upstream = await createMessages<AnthropicResponse>(payload, {
      signal: AbortSignal.any([c.req.raw.signal, upstreamController.signal]),
      stream: payload.stream === true,
      initiator: isNativeAgentCall(payload) ? "agent" : "user",
      anthropicVersion: c.req.header("anthropic-version"),
      anthropicBeta: c.req.header("anthropic-beta"),
      onResponse: (response) => forwardMessagesHeaders(c, response),
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
    recordNormalizedUsage(c, {
      model: response.model,
      usage: normalizeAnthropicUsage(response.usage, {
        usageComplete: true,
      }),
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
    (error, stream) => handleAnthropicStreamFatalError(error, stream),
  )
}

interface NativeStreamUsage {
  input: number | null
  startOutput: number | null
  deltaOutput: number | null
  cacheCreation: number | null
  cacheRead: number | null
  cacheCreationDetail: AnthropicUsageLike["cache_creation"]
  sawMessageStop: boolean
  sawErrorEvent: boolean
}

interface NativeMessageStreamPayload {
  type?: string
  message?: Partial<AnthropicResponse>
  usage?: AnthropicUsageLike
  copilot_usage?: AnthropicResponse["copilot_usage"]
  copilot_info_messages?: AnthropicResponse["copilot_info_messages"]
}

function captureNativeUsageFields(
  source: AnthropicUsageLike | undefined,
  target: NativeStreamUsage,
  isDelta: boolean,
): void {
  if (!source) return
  if (typeof source.input_tokens === "number")
    target.input = source.input_tokens
  if (typeof source.output_tokens === "number") {
    if (isDelta) target.deltaOutput = source.output_tokens
    else target.startOutput = source.output_tokens
  }
  if (typeof source.cache_creation_input_tokens === "number")
    target.cacheCreation = source.cache_creation_input_tokens
  if (typeof source.cache_read_input_tokens === "number")
    target.cacheRead = source.cache_read_input_tokens
  if (source.cache_creation) target.cacheCreationDetail = source.cache_creation
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
  data: string | undefined,
  usage: NativeStreamUsage,
  meta: NativeStreamMeta,
): string | undefined {
  if (!data) return
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    // Metadata capture is best-effort; the original event is still forwarded.
    return
  }
  if (typeof value !== "object" || value === null) return
  const parsed = value as NativeMessageStreamPayload

  if (parsed.message?.model) meta.model = parsed.message.model
  captureNativeUsageFields(parsed.message?.usage, usage, false)
  captureNativeUsageFields(parsed.usage, usage, true)
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
  return parsed.type
}

function finalizeNativeUsage(usage: NativeStreamUsage, status: number) {
  const streamClean =
    usage.sawMessageStop && !usage.sawErrorEvent && status === 200
  const finalOutput =
    usage.deltaOutput ?? (streamClean ? usage.startOutput : null)
  const hasAny =
    usage.input !== null
    || finalOutput !== null
    || usage.cacheRead !== null
    || usage.cacheCreation !== null
    || Boolean(usage.cacheCreationDetail)
  return normalizeAnthropicUsage(
    hasAny ?
      {
        input_tokens: usage.input,
        output_tokens: finalOutput,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheCreation,
        cache_creation: usage.cacheCreationDetail,
      }
    : undefined,
    { usageComplete: streamClean && finalOutput !== null },
  )
}

interface NativeLoopState {
  usage: NativeStreamUsage
  meta: NativeStreamMeta
  abortState: { aborted: boolean }
  terminal: boolean
}

async function forwardNativeEvents(
  stream: SSEStreamingApi,
  response: AsyncIterable<NativeMessagesStreamEvent>,
  loop: NativeLoopState,
): Promise<void> {
  for await (const rawEvent of response) {
    if (loop.abortState.aborted) break
    const type = captureNativeEvent(rawEvent.data, loop.usage, loop.meta)
    const eventName = rawEvent.event ?? type
    if (eventName === "message_stop") loop.usage.sawMessageStop = true
    if (eventName === "error") loop.usage.sawErrorEvent = true
    if (isNativeTerminalEvent(eventName)) loop.terminal = true
    if (rawEvent.data !== undefined) {
      await stream.writeSSE({
        data: rawEvent.data,
        event: rawEvent.event,
        id: rawEvent.id === undefined ? undefined : String(rawEvent.id),
        retry: rawEvent.retry,
      })
    }
  }
}

async function pipeNativeAnthropicStream(
  stream: SSEStreamingApi,
  ctx: NativeStreamContext,
): Promise<void> {
  const { response, c, requestedModel, upstreamController } = ctx
  const loop: NativeLoopState = {
    usage: {
      input: null,
      startOutput: null,
      deltaOutput: null,
      cacheCreation: null,
      cacheRead: null,
      cacheCreationDetail: undefined,
      sawMessageStop: false,
      sawErrorEvent: false,
    },
    meta: { model: requestedModel, costNanoAiu: null },
    abortState: { aborted: false },
    terminal: false,
  }
  const isAborted = () => loop.abortState.aborted || c.req.raw.signal.aborted
  let status = 200
  const active = () => !isAborted() && !stream.closed

  stream.onAbort(() => {
    loop.abortState.aborted = true
    upstreamController.abort()
  })

  const pingInterval = setInterval(() => {
    if (loop.abortState.aborted || stream.closed) return
    stream
      .writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) })
      .catch(() => {
        /* stream may be closing */
      })
  }, 10_000)

  try {
    await forwardNativeEvents(stream, response, loop)
    if (loop.usage.sawErrorEvent) status = 502
    if (!loop.terminal && active())
      throw new Error("Upstream Messages stream ended before message_stop")
  } catch (error) {
    status = isAborted() ? 499 : 502
    consola.error(
      "Upstream native messages stream failed:",
      formatErrorWithCause(error),
    )
    if (active() && !loop.terminal) {
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
    if (!loop.usage.sawMessageStop && isAborted()) status = 499
    clearInterval(pingInterval)
    upstreamController.abort()
    recordNormalizedUsage(c, {
      model: loop.meta.model,
      usage: finalizeNativeUsage(loop.usage, status),
      costNanoAiu: loop.meta.costNanoAiu,
    })
    flushUsage(c, status)
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
  rawUsage: ChatUsageLike | undefined
  c: Context
  model: string
  upstreamController: AbortController
}

interface StreamMeta {
  state: AnthropicStreamState
  cost: number | null
}

function captureStreamUsage(
  chunk: ChatCompletionChunk,
  ctx: RunAnthropicStreamCtx,
) {
  if (!chunk.usage) return
  const u = chunk.usage
  ctx.usage.prompt = u.prompt_tokens ?? ctx.usage.prompt
  ctx.usage.completion = u.completion_tokens ?? ctx.usage.completion
  ctx.usage.total = u.total_tokens ?? ctx.usage.total
  ctx.usage.cached = u.prompt_tokens_details?.cached_tokens ?? ctx.usage.cached
  ctx.usage.cacheCreation =
    u.prompt_tokens_details?.cache_creation_input_tokens
    ?? ctx.usage.cacheCreation
  ctx.rawUsage = {
    ...ctx.rawUsage,
    ...u,
    prompt_tokens_details:
      u.prompt_tokens_details ?? ctx.rawUsage?.prompt_tokens_details,
    completion_tokens_details:
      u.completion_tokens_details ?? ctx.rawUsage?.completion_tokens_details,
  }
}

async function finalizeAnthropicStream(
  stream: SSEStreamingApi,
  state: AnthropicStreamState,
  usage: RunAnthropicStreamCtx["usage"],
) {
  state.finalEventsSent = true
  const write = (event: string, data: unknown) =>
    stream.writeSSE({ event, data: JSON.stringify(data) })
  await emitCopilotInfoIfAny(state, write)
  await write("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: mapOpenAIStopReasonToAnthropic(
        state.finishReason as
          | "stop"
          | "length"
          | "tool_calls"
          | "content_filter",
      ),
      stop_sequence: null,
    },
    usage: {
      input_tokens: Math.max(
        0,
        usage.prompt - usage.cached - usage.cacheCreation,
      ),
      output_tokens: usage.completion,
      ...(usage.cached > 0 && { cache_read_input_tokens: usage.cached }),
      ...(usage.cacheCreation > 0 && {
        cache_creation_input_tokens: usage.cacheCreation,
      }),
    },
  })
  await write("message_stop", { type: "message_stop" })
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

function isNativeTerminalEvent(type: string | undefined): boolean {
  return type === "message_stop" || type === "error"
}

function readChatStreamChunk(data: string): ChatCompletionChunk {
  const chunk = JSON.parse(data) as ChatCompletionChunk & {
    error?: { message?: string }
  }
  if (chunk.error)
    throw new Error(chunk.error.message ?? "Upstream chat stream failed")
  return chunk
}

function assertChatStreamCompleted(
  done: boolean,
  state: AnthropicStreamState,
): void {
  if (!done || !state.finishReason || !state.messageStartSent)
    throw new Error("Upstream chat stream ended before completion")
}

interface TranslatedLoopArgs {
  ctx: RunAnthropicStreamCtx
  meta: StreamMeta
  abortState: { aborted: boolean }
}

async function consumeTranslatedChatStream(
  stream: SSEStreamingApi,
  args: TranslatedLoopArgs,
): Promise<boolean> {
  const { ctx, meta, abortState } = args
  for await (const rawEvent of ctx.response) {
    if (abortState.aborted) break
    consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
    if (rawEvent.data === "[DONE]") return true
    if (!rawEvent.data) continue

    const chunk = readChatStreamChunk(rawEvent.data)
    captureStreamUsage(chunk, ctx)
    captureChunkMetadata(chunk, meta, ctx.model)
    const events = translateChunkToAnthropicEvents(chunk, meta.state)
    for (const event of events) {
      consola.debug("Translated Anthropic event:", JSON.stringify(event))
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }
  }
  return false
}

async function runAnthropicStream(
  stream: SSEStreamingApi,
  ctx: RunAnthropicStreamCtx,
): Promise<void> {
  const { usage, c, model, upstreamController } = ctx
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  const meta: StreamMeta = { state: streamState, cost: null }
  const abortState = { aborted: false }
  const isAborted = () => abortState.aborted || c.req.raw.signal.aborted
  const active = () => !isAborted() && !stream.closed
  const finalizerState = { ran: false }
  let done = false
  let status = 200

  stream.onAbort(() => {
    abortState.aborted = true
    consola.debug("Client aborted Anthropic stream")
    upstreamController.abort()
  })

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
  sendPing()
  const pingInterval = setInterval(sendPing, 10_000)

  try {
    done = await consumeTranslatedChatStream(stream, { ctx, meta, abortState })
    if (active()) assertChatStreamCompleted(done, streamState)
  } catch (error) {
    status = isAborted() ? 499 : 502
    consola.error(
      "Upstream stream error, closing gracefully:",
      formatErrorWithCause(error),
    )
    if (active()) {
      await emitAnthropicStreamError(stream, {
        streamState,
        error,
        finalizerState,
      })
    }
  } finally {
    if (!done && isAborted()) status = 499
    clearInterval(pingInterval)
    upstreamController.abort()

    try {
      if (active() && !streamState.finalEventsSent && !finalizerState.ran) {
        await finalizeAnthropicStream(stream, streamState, usage)
      }
    } finally {
      const usageComplete =
        done
        && status === 200
        && !finalizerState.ran
        && ctx.rawUsage !== undefined
      recordNormalizedUsage(c, {
        model,
        usage: normalizeChatUsage(ctx.rawUsage, { usageComplete }),
        costNanoAiu: meta.cost,
      })
      flushUsage(c, status)
    }
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
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
