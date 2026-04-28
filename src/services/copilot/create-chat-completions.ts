import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  recordResponsesOnlyModel,
  shouldUseResponsesEndpoint,
} from "~/lib/responses-routing"
import { state } from "~/lib/state"
import {
  chatRequestToResponses,
  responsesStreamToChatStream,
  responsesToChatResponse,
} from "~/lib/translation/chat-to-responses"
import { createResponses } from "~/services/copilot/create-responses"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options?: { signal?: AbortSignal },
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Route Responses-only models (whitelisted at /models fetch time, or learned
  // via the runtime cache after a previous unsupported_api_for_model failure)
  // straight to the /responses upstream. Translate the response back to chat
  // shape so the caller sees no protocol difference.
  if (shouldUseResponsesEndpoint(payload.model)) {
    return callViaResponses(payload, options)
  }

  try {
    return await callChatCompletions(payload, options)
  } catch (error) {
    if (isUnsupportedApiForModelError(error)) {
      consola.warn(
        `Model "${payload.model}" not available on /chat/completions; retrying via /responses.`,
      )
      recordResponsesOnlyModel(payload.model)
      return callViaResponses(payload, options)
    }
    throw error
  }
}

async function callChatCompletions(
  payload: ChatCompletionsPayload,
  options?: { signal?: AbortSignal },
) {
  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  consola.info("Sending to upstream, message count:", payload.messages.length)

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options?.signal,
  })

  if (!response.ok) {
    const bodyText = await response.text()
    consola.error("HTTP error:", bodyText)
    throw new HTTPError("Failed to create chat completions", response, bodyText)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

async function callViaResponses(
  payload: ChatCompletionsPayload,
  options?: { signal?: AbortSignal },
) {
  const responsesPayload = chatRequestToResponses(payload)
  const upstream = await createResponses(responsesPayload, options)

  if (payload.stream) {
    return responsesStreamToChatStream(
      upstream as AsyncIterable<{ event?: string; data?: string }>,
      payload.model,
    )
  }

  return responsesToChatResponse(
    upstream as Awaited<ReturnType<typeof createResponses>> as any,
  )
}

function isUnsupportedApiForModelError(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  const text = error.bodyText
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string } }
    return parsed.error?.code === "unsupported_api_for_model"
  } catch {
    return text.includes("unsupported_api_for_model")
  }
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
