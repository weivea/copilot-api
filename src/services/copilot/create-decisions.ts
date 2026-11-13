import type { DecisionsPayload } from "~/lib/openai-request"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type { CopilotInfoMessage, CopilotUsage } from "./types-shared"

export interface DecisionsResponse {
  model?: string
  answers: Array<unknown>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  copilot_usage?: CopilotUsage
  copilot_info_messages?: Array<CopilotInfoMessage>
}

export async function createDecisions(
  payload: DecisionsPayload,
  options?: {
    signal?: AbortSignal
    onResponse?: (response: Response) => void
  },
): Promise<DecisionsResponse> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision =
    (Array.isArray(payload.input)
      && payload.input.some(
        (item) =>
          Array.isArray(item.content)
          && item.content.some((part) => part.type === "input_image"),
      ))
    || payload.questions.some(
      (question) =>
        Array.isArray(question.instructions)
        && question.instructions.some((part) => part.type === "input_image"),
    )

  const response = await fetch(`${copilotBaseUrl(state)}/v1/decisions`, {
    method: "POST",
    headers: {
      ...copilotHeaders(state, enableVision),
      "X-Initiator": "user",
    },
    body: JSON.stringify(payload),
    signal: options?.signal,
  })
  options?.onResponse?.(response)

  if (!response.ok)
    throw new HTTPError(
      "Failed to create decisions",
      response,
      await response.text(),
    )

  return (await response.json()) as DecisionsResponse
}
