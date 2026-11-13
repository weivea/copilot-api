import type { ImagesPayload } from "~/lib/openai-request"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type { CopilotInfoMessage, CopilotUsage } from "./types-shared"

export type ImageOperation = "generations" | "edits"

export interface ImagesResponse {
  model?: string
  type?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  copilot_usage?: CopilotUsage
  copilot_info_messages?: Array<CopilotInfoMessage>
}

export async function createImages(
  operation: ImageOperation,
  payload: ImagesPayload | FormData,
  signal: AbortSignal,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers = new Headers({
    ...copilotHeaders(state, operation === "edits"),
    "X-Initiator": "user",
    accept: "application/json, text/event-stream",
  })
  const multipart = payload instanceof FormData
  // Fetch must supply the boundary matching its serialized FormData.
  if (multipart) headers.delete("content-type")

  const response = await fetch(
    `${copilotBaseUrl(state)}/v1/images/${operation}`,
    {
      method: "POST",
      headers,
      body: multipart ? payload : JSON.stringify(payload),
      signal,
    },
  )
  if (!response.ok)
    throw new HTTPError(
      `Failed to create image ${operation}`,
      response,
      await response.text(),
    )
  return response
}
