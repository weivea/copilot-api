import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage-recorder"
import { isNullish } from "~/lib/utils"
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

function hasThinkingBlock(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false
  if (obj.type === "thinking") return true
  if (Array.isArray(obj)) return obj.some(hasThinkingBlock)
  // Check all values of the object
  return Object.values(obj).some(hasThinkingBlock)
}

function removeThinkingBlocks(content: any): any {
  if (!content) return content

  // Array: filter out thinking blocks
  if (Array.isArray(content)) {
    const filtered = content.filter((item: any) => {
      if (item && typeof item === "object" && item.type === "thinking")
        return false
      return true
    })
    if (filtered.length === 0) return ""
    if (
      filtered.length === 1
      && filtered[0]?.type === "text"
      && typeof filtered[0]?.text === "string"
    ) {
      return filtered[0].text
    }
    return filtered
  }

  // String: try parsing as JSON in case thinking blocks are serialized
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content)
      if (
        Array.isArray(parsed)
        && parsed.some((b: any) => b?.type === "thinking")
      ) {
        const filtered = parsed.filter((b: any) => !(b?.type === "thinking"))
        if (filtered.length === 0) return ""
        if (filtered.length === 1 && filtered[0]?.type === "text")
          return filtered[0].text
        return filtered
      }
    } catch {}
    return content
  }

  // Object (not array): if it IS a thinking block, return empty
  if (typeof content === "object" && content.type === "thinking") return ""

  return content
}

function stripThinkingBlocks(messages: Array<any>): Array<any> {
  let totalStripped = 0
  const result = messages.map((msg, idx) => {
    if (!msg.content) return msg

    const had = hasThinkingBlock(msg.content)
    if (!had) return msg

    totalStripped++
    consola.info(
      "Stripping thinking from msg["
        + idx
        + "] role="
        + msg.role
        + " contentType="
        + typeof msg.content
        + " isArray="
        + Array.isArray(msg.content),
    )
    const cleaned = removeThinkingBlocks(msg.content)
    return { ...msg, content: cleaned }
  })
  consola.info(
    "stripThinkingBlocks: messages with thinking stripped = " + totalStripped,
  )
  return result
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()

  // Log FULL message structure for debugging
  payload.messages.forEach((msg: any, idx: number) => {
    const msgStr = JSON.stringify(msg)
    if (msgStr.length > 500) {
      consola.info(
        "msg["
          + idx
          + "] role="
          + msg.role
          + " (truncated): "
          + msgStr.slice(0, 500)
          + "...",
      )
    } else {
      consola.info("msg[" + idx + "] role=" + msg.role + ": " + msgStr)
    }
  })

  // Search entire payload for thinking/signature keywords
  const fullPayload = JSON.stringify(payload)
  const thinkingIdx = fullPayload.indexOf('"thinking"')
  const signatureIdx = fullPayload.indexOf('"signature"')
  const reasoningIdx = fullPayload.indexOf('"reasoning_text"')
  consola.info(
    "Payload scan - thinking at:"
      + thinkingIdx
      + " signature at:"
      + signatureIdx
      + " reasoning_text at:"
      + reasoningIdx,
  )
  if (signatureIdx > 0) {
    consola.info(
      "Signature context: ..."
        + fullPayload.slice(Math.max(0, signatureIdx - 100), signatureIdx + 100)
        + "...",
    )
  }
  if (thinkingIdx > 0) {
    consola.info(
      "Thinking context: ..."
        + fullPayload.slice(Math.max(0, thinkingIdx - 100), thinkingIdx + 100)
        + "...",
    )
  }

  // Also strip reasoning_text from assistant messages (causes thinking block validation)
  payload.messages = payload.messages.map((msg: any) => {
    if (msg.reasoning_text !== undefined) {
      consola.info("Removing reasoning_text from " + msg.role + " message")
      const { reasoning_text, ...rest } = msg
      return rest
    }
    return msg
  })

  // Strip thinking blocks
  if (payload.messages) {
    payload = { ...payload, messages: stripThinkingBlocks(payload.messages) }
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
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

  const response = await createChatCompletions(payload)

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
  return streamSSE(
    c,
    (stream) => pipeOpenAIStream(stream, response, usage, c, payload.model),
    (error) => {
      consola.error("streamSSE onError (chat-completions):", error)
      return Promise.resolve()
    },
  )
}

async function pipeOpenAIStream(
  stream: SSEStreamingApi,
  response: AsyncIterable<{ data?: string }>,
  usage: { prompt: number; completion: number; total: number },
  c: Context,
  model: string,
): Promise<void> {
  const abortState = { aborted: false }
  stream.onAbort(() => {
    abortState.aborted = true
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
          const parsed = JSON.parse(chunk.data)
          if (parsed?.usage) {
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
    consola.error("Upstream stream error, closing gracefully:", error)
    if (!abortState.aborted) {
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
    recordUsage(c, {
      model,
      promptTokens: usage.prompt || null,
      completionTokens: usage.completion || null,
      totalTokens: usage.total || null,
    })
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
