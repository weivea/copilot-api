import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
import {
  chatRequestSchema,
  invalidRequest,
  readJson,
} from "~/lib/openai-request"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage, deferUsage, flushUsage } from "~/lib/usage-recorder"
import { formatErrorWithCause } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

function isGptModel(model: string): boolean {
  return (
    model.startsWith("gpt-")
    || model.startsWith("o1-")
    || model.startsWith("o3-")
    || model.startsWith("o4-")
  )
}

interface ThinkingBlock {
  type: "thinking"
  [k: string]: unknown
}
interface TextBlock {
  type: "text"
  text: string
  [k: string]: unknown
}
type ContentBlock =
  | ThinkingBlock
  | TextBlock
  | { type: string; [k: string]: unknown }
type MessageContent =
  | string
  | Array<ContentBlock>
  | ContentBlock
  | null
  | undefined

function isThinkingBlock(value: unknown): value is ThinkingBlock {
  return (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "thinking"
  )
}

function collapseFiltered(filtered: Array<ContentBlock>): MessageContent {
  if (filtered.length === 0) return ""
  const first = filtered[0]
  if (
    filtered.length === 1
    && first.type === "text"
    && typeof (first as TextBlock).text === "string"
    && Object.keys(first).length === 2
  ) {
    return (first as TextBlock).text
  }
  return filtered
}

function removeThinkingBlocks(content: MessageContent): MessageContent {
  if (!content) return content

  // Array: filter out thinking blocks
  if (Array.isArray(content)) {
    if (!content.some((item) => isThinkingBlock(item))) return content
    const filtered = content.filter((item) => !isThinkingBlock(item))
    return collapseFiltered(filtered)
  }

  // String: try parsing as JSON in case thinking blocks are serialized
  if (typeof content === "string") {
    try {
      const parsed: unknown = JSON.parse(content)
      if (Array.isArray(parsed) && parsed.some((b) => isThinkingBlock(b))) {
        const filtered = (parsed as Array<ContentBlock>).filter(
          (b) => !isThinkingBlock(b),
        )
        return collapseFiltered(filtered)
      }
    } catch {
      /* not JSON — return original below */
    }
    return content
  }

  // Object (not array): if it IS a thinking block, return empty
  if (isThinkingBlock(content)) return ""

  return content
}

interface ChatMessage {
  role?: string
  content?: MessageContent
  reasoning_text?: unknown
  [k: string]: unknown
}

async function readChatPayload(c: Context): Promise<ChatCompletionsPayload> {
  const raw = await readJson(c)
  // Retain support for clients echoing Anthropic thinking blocks.
  if (
    typeof raw === "object"
    && raw !== null
    && "messages" in raw
    && Array.isArray(raw.messages)
  ) {
    raw.messages = raw.messages.map((message: unknown) => {
      if (
        typeof message !== "object"
        || message === null
        || !("content" in message)
      )
        return message
      return {
        ...message,
        content: removeThinkingBlocks(message.content as MessageContent),
      }
    })
  }
  const parsed = chatRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidRequest(issue.message, issue.path.join("."))
  }
  const payload: ChatCompletionsPayload = {
    ...parsed.data,
    messages: parsed.data.messages.map((message) => ({
      ...message,
      content: message.content ?? null,
    })),
  }
  // Strip reasoning_text from assistant messages (some clients echo it back
  // and upstream rejects it as an unknown field on assistant turns).
  payload.messages = payload.messages.map((msg) => {
    const m = msg as ChatMessage
    if (m.reasoning_text !== undefined) {
      const { reasoning_text: _ignored, ...rest } = m
      return rest as typeof msg
    }
    return msg
  })

  return payload
}

function normalizeTokenLimit(payload: ChatCompletionsPayload) {
  const budget = payload.max_completion_tokens ?? payload.max_tokens
  if (isGptModel(payload.model)) {
    payload.max_completion_tokens = budget
    delete payload.max_tokens
  } else {
    payload.max_tokens = budget
    delete payload.max_completion_tokens
  }
}

async function logTokenEstimate(
  payload: ChatCompletionsPayload,
  selectedModel: Model | undefined,
) {
  // Local token estimation is purely diagnostic and CPU-heavy (full BPE
  // encoding). Skip unless the consola log level is at debug or below.
  if (selectedModel && consola.level >= 4) {
    try {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.debug("Estimated token count:", tokenCount)
    } catch (error) {
      consola.warn("Failed to calculate token count:", error)
    }
  }
}

export async function handleCompletion(c: Context) {
  const payload = await readChatPayload(c)
  await checkRateLimit(state)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  await logTokenEstimate(payload, selectedModel)

  if (state.manualApprove) await awaitApproval()

  normalizeTokenLimit(payload)

  // AbortController governs the upstream fetch so we can cancel cleanly on
  // client disconnect; otherwise an orphaned upstream socket eventually shows
  // up as "socket closed unexpectedly" on the client side.
  const upstreamController = new AbortController()
  const onRequestAbort = () => upstreamController.abort()
  c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true })
  if (c.req.raw.signal.aborted) upstreamController.abort()
  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(payload, {
      signal: upstreamController.signal,
    })
  } catch (error) {
    c.req.raw.signal.removeEventListener("abort", onRequestAbort)
    consola.error(
      "Upstream chat completions failed:",
      formatErrorWithCause(error),
    )
    throw error
  }

  if (isNonStreaming(response)) {
    c.req.raw.signal.removeEventListener("abort", onRequestAbort)
    captureInfoMessages(response, {
      endpoint: "/v1/chat/completions",
      model: response.model,
    })
    recordUsage(c, {
      model: payload.model,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      costNanoAiu: pickCostNanoAiu(response),
    })
    return c.json(response)
  }

  const usage = { prompt: 0, completion: 0, total: 0 }
  deferUsage(c)
  return streamSSE(
    c,
    (stream) =>
      pipeOpenAIStream(stream, {
        response,
        usage,
        c,
        model: payload.model,
        upstreamController,
        includeUsage: payload.stream_options?.include_usage === true,
        costNanoAiu: null,
        onRequestAbort,
        created: Math.floor(Date.now() / 1000),
      }),
    (error) => {
      consola.error(
        "streamSSE onError (chat-completions):",
        formatErrorWithCause(error),
      )
      return Promise.resolve()
    },
  )
}

interface PipeOpenAIStreamCtx {
  response: AsyncIterable<{ data?: string }>
  usage: { prompt: number; completion: number; total: number }
  c: Context
  model: string
  upstreamController: AbortController
  includeUsage: boolean
  costNanoAiu: number | null
  onRequestAbort: () => void
  created: number
}

async function forwardChatChunk(
  stream: SSEStreamingApi,
  data: string,
  ctx: PipeOpenAIStreamCtx,
) {
  const upstream = JSON.parse(data) as Partial<ChatCompletionChunk>
  const parsed =
    Array.isArray(upstream.choices) ?
      {
        ...upstream,
        object: "chat.completion.chunk" as const,
        created: upstream.created ?? ctx.created,
        model: upstream.model ?? ctx.model,
      }
    : upstream
  if (parsed.usage) {
    ctx.usage.prompt = parsed.usage.prompt_tokens ?? ctx.usage.prompt
    ctx.usage.completion =
      parsed.usage.completion_tokens ?? ctx.usage.completion
    ctx.usage.total = parsed.usage.total_tokens ?? ctx.usage.total
  }
  captureInfoMessages(parsed, {
    endpoint: "/v1/chat/completions",
    model: parsed.model,
  })
  ctx.costNanoAiu = pickCostNanoAiu(parsed) ?? ctx.costNanoAiu
  if (!Array.isArray(parsed.choices)) {
    await stream.writeSSE({ data: JSON.stringify(parsed) })
    return
  }
  const { usage, ...rest } = parsed
  if (parsed.choices.length > 0)
    await stream.writeSSE({
      data: JSON.stringify({
        ...rest,
        ...(ctx.includeUsage && { usage: null }),
      }),
    })
  if (ctx.includeUsage && usage)
    await stream.writeSSE({
      data: JSON.stringify({ ...rest, choices: [], usage }),
    })
}

async function pipeOpenAIStream(
  stream: SSEStreamingApi,
  ctx: PipeOpenAIStreamCtx,
): Promise<void> {
  const { response, usage, c, model, upstreamController } = ctx
  const abortState = { aborted: false }
  let completed = false
  // Idempotency guard: protect the post-error writes from being entered twice
  // if the catch path and a subsequent fault both fire.
  const finalizerState = { ran: false }
  stream.onAbort(() => {
    abortState.aborted = true
    upstreamController.abort()
  })

  // Keep-alive comment frames so proxies don't close idle sockets while
  // upstream is slow to produce the first / next token.
  const pingInterval = setInterval(() => {
    if (abortState.aborted || stream.closed) return
    stream.write(": keepalive\n\n").catch(() => {
      /* ignore */
    })
  }, 15_000)

  try {
    for await (const chunk of response) {
      if (abortState.aborted) break
      if (chunk.data === undefined) continue
      if (chunk.data === "[DONE]") {
        completed = true
        await stream.writeSSE({ data: "[DONE]" })
        break
      }
      if (chunk.data) await forwardChatChunk(stream, chunk.data, ctx)
    }
    if (!completed && !abortState.aborted) {
      throw new Error("Upstream chat stream ended before [DONE]")
    }
  } catch (error) {
    consola.error(
      "Upstream stream error, closing gracefully:",
      formatErrorWithCause(error),
    )
    if (!abortState.aborted && !finalizerState.ran) {
      finalizerState.ran = true
      const message = error instanceof Error ? error.message : String(error)
      try {
        await stream.writeSSE({
          data: JSON.stringify({
            error: { message, type: "upstream_error" },
          }),
        })
        await stream.writeSSE({ data: "[DONE]" })
      } catch {
        /* ignore */
      }
    }
  } finally {
    clearInterval(pingInterval)
    upstreamController.abort()
    c.req.raw.signal.removeEventListener("abort", ctx.onRequestAbort)
    recordUsage(c, {
      model,
      promptTokens: usage.prompt || null,
      completionTokens: usage.completion || null,
      totalTokens: usage.total || null,
      costNanoAiu: ctx.costNanoAiu,
    })
    flushUsage(c)
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
