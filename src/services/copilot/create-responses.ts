import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createResponses = async (
  payload: ResponsesPayload,
  options?: { signal?: AbortSignal },
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Vision detection: any input item carrying an input_image part.
  const enableVision =
    Array.isArray(payload.input)
    && payload.input.some(
      (item) =>
        typeof item === "object"
        && item !== null
        && "content" in item
        && Array.isArray((item as { content?: unknown }).content)
        && (item as { content: Array<{ type?: string }> }).content.some(
          (c) => c.type === "input_image",
        ),
    )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
  }

  consola.info(
    "Sending to upstream /responses, model:",
    payload.model,
    "stream:",
    !!payload.stream,
  )

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options?.signal,
  })

  if (!response.ok) {
    const bodyText = await response.text()
    consola.error("HTTP error (/responses):", bodyText)
    throw new HTTPError("Failed to create responses", response, bodyText)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

// ---- Request types --------------------------------------------------------

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string | null
  stream?: boolean | null
  store?: boolean | null
  previous_response_id?: string | null
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stop?: string | Array<string> | null
  tools?: Array<ResponsesTool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; name: string }
    | null
  reasoning?: { effort?: "low" | "medium" | "high" } | null
  modalities?: Array<string> | null
  metadata?: Record<string, string> | null
  user?: string | null
  truncation?: "auto" | "disabled" | null
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

export interface ResponsesMessageItem {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: Array<ResponsesContentPart>
}

export interface ResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; file_id: string }

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
}

// ---- Response types -------------------------------------------------------

export interface ResponsesResponse {
  id: string
  object: "response"
  created_at: number
  status: "completed" | "in_progress" | "failed" | "incomplete"
  model: string
  instructions?: string | null
  output: Array<ResponsesOutputItem>
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message: string; code?: string } | null
  metadata?: Record<string, string>
  incomplete_details?: { reason?: string } | null
}

export type ResponsesOutputItem =
  | ResponsesMessageOutput
  | ResponsesFunctionCallOutput
  | ResponsesReasoningOutput

export interface ResponsesMessageOutput {
  type: "message"
  id: string
  status: "completed" | "in_progress"
  role: "assistant"
  content: Array<
    | { type: "output_text"; text: string; annotations?: Array<unknown> }
    | { type: "refusal"; refusal: string }
  >
}

export interface ResponsesFunctionCallOutput {
  type: "function_call"
  id: string
  call_id: string
  name: string
  arguments: string
  status: "completed" | "in_progress"
}

export interface ResponsesReasoningOutput {
  type: "reasoning"
  id: string
  summary: Array<{ type: "summary_text"; text: string }>
}
