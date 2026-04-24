import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage, deferUsage, flushUsage } from "~/lib/usage-recorder"
import { isNullish, formatErrorWithCause } from "~/lib/utils"
import {
  createChatCompletions,
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

function hasThinkingBlock(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false
  if (isThinkingBlock(obj)) return true
  if (Array.isArray(obj)) return obj.some((v) => hasThinkingBlock(v))
  return Object.values(obj as Record<string, unknown>).some((v) =>
    hasThinkingBlock(v),
  )
}

function collapseFiltered(filtered: Array<ContentBlock>): MessageContent {
  if (filtered.length === 0) return ""
  const first = filtered[0]
  if (
    filtered.length === 1
    && first.type === "text"
    && typeof (first as TextBlock).text === "string"
  ) {
    return (first as TextBlock).text
  }
  return filtered
}

function removeThinkingBlocks(content: MessageContent): MessageContent {
  if (!content) return content

  // Array: filter out thinking blocks
  if (Array.isArray(content)) {
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

function stripThinkingBlocks(messages: Array<ChatMessage>): Array<ChatMessage> {
  let totalStripped = 0
  const result = messages.map((msg) => {
    if (!msg.content) return msg
    if (!hasThinkingBlock(msg.content)) return msg
    totalStripped++
    return { ...msg, content: removeThinkingBlocks(msg.content) }
  })
  if (totalStripped > 0) {
    consola.debug(
      `stripThinkingBlocks: stripped thinking blocks from ${totalStripped} message(s)`,
    )
  }
  return result
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()

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

  // Strip thinking blocks (Anthropic-style content) — upstream chat/completions
  // does not understand them and will fail validation.
  payload = {
    ...payload,
    messages: stripThinkingBlocks(
      payload.messages as Array<ChatMessage>,
    ) as typeof payload.messages,
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

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

  if (state.manualApprove) await awaitApproval()

  const gpt = isGptModel(payload.model)
  if (gpt) {
    if (isNullish((payload as any).max_completion_tokens)) {
      const limit = selectedModel?.capabilities.limits.max_output_tokens
      ;(payload as any).max_completion_tokens = limit
    }
    delete (payload as any).max_tokens
  } else if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
  }

  // AbortController governs the upstream fetch so we can cancel cleanly on
  // client disconnect; otherwise an orphaned upstream socket eventually shows
  // up as "socket closed unexpectedly" on the client side.
  const upstreamController = new AbortController()
  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(payload, {
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
    recordUsage(c, {
      model: payload.model,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
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
}

async function pipeOpenAIStream(
  stream: SSEStreamingApi,
  ctx: PipeOpenAIStreamCtx,
): Promise<void> {
  const { response, usage, c, model, upstreamController } = ctx
  const abortState = { aborted: false }
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
      if (chunk.data && chunk.data !== "[DONE]") {
        try {
          const parsed = JSON.parse(chunk.data) as {
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              total_tokens?: number
            }
          }
          if (parsed.usage) {
            usage.prompt = parsed.usage.prompt_tokens ?? usage.prompt
            usage.completion =
              parsed.usage.completion_tokens ?? usage.completion
            usage.total = parsed.usage.total_tokens ?? usage.total
          }
        } catch {
          /* not json */
        }
      }
      await stream.writeSSE({ data: chunk.data })
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
    recordUsage(c, {
      model,
      promptTokens: usage.prompt || null,
      completionTokens: usage.completion || null,
      totalTokens: usage.total || null,
    })
    flushUsage(c)
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
