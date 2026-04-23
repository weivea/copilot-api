import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { recordUsage } from "~/lib/usage-recorder"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

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
    recordUsage(c, {
      model: openAIPayload.model,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
    })
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  const usage = { prompt: 0, completion: 0, total: 0 }
  return streamSSE(
    c,
    (stream) => runAnthropicStream(stream, response, usage),
    (error, stream) => handleAnthropicStreamFatalError(error, stream),
  ).finally(() =>
    recordUsage(c, {
      model: openAIPayload.model,
      promptTokens: usage.prompt || null,
      completionTokens: usage.completion || null,
      totalTokens: usage.total || null,
    }),
  )
}

async function runAnthropicStream(
  stream: SSEStreamingApi,
  response: AsyncIterable<{ data?: string }>,
  usage: { prompt: number; completion: number; total: number },
): Promise<void> {
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }

  const abortState = { aborted: false }
  stream.onAbort(() => {
    abortState.aborted = true
    consola.debug("Client aborted Anthropic stream")
  })

  // Periodic SSE ping to keep intermediaries from closing the socket
  // while upstream is slow to produce the first / next token.
  const pingInterval = setInterval(() => {
    if (abortState.aborted || stream.closed) return
    stream
      .writeSSE({
        event: "ping",
        data: JSON.stringify({ type: "ping" }),
      })
      .catch(() => {
        /* ignore: stream may be closing */
      })
  }, 15_000)

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
      if ((chunk as any).usage) {
        usage.prompt = (chunk as any).usage.prompt_tokens ?? usage.prompt
        usage.completion = (chunk as any).usage.completion_tokens ?? usage.completion
        usage.total = (chunk as any).usage.total_tokens ?? usage.total
      }
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
    consola.error("Upstream stream error, closing gracefully:", error)
    if (!abortState.aborted) {
      await emitAnthropicStreamError(stream, streamState, error)
    }
  } finally {
    clearInterval(pingInterval)
  }
}

async function handleAnthropicStreamFatalError(
  error: Error,
  stream: SSEStreamingApi,
): Promise<void> {
  consola.error("streamSSE onError:", error)
  try {
    await emitAnthropicStreamError(
      stream,
      {
        messageStartSent: true,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      },
      error,
    )
  } catch {
    /* ignore */
  }
}

async function emitAnthropicStreamError(
  stream: SSEStreamingApi,
  streamState: AnthropicStreamState,
  error: unknown,
): Promise<void> {
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
