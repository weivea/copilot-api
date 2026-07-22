import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface NativeMessagesStreamEvent {
  event?: string
  data?: string
  id?: string | number
  retry?: number
}

interface CreateMessagesOptions {
  signal?: AbortSignal
  stream: boolean
  initiator: "user" | "agent"
  anthropicVersion?: string
  anthropicBeta?: string
}

export async function createMessages<TResponse>(
  payload: object,
  options: CreateMessagesOptions,
): Promise<TResponse | AsyncIterable<NativeMessagesStreamEvent>> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state),
    "X-Initiator": options.initiator,
    "anthropic-version": options.anthropicVersion ?? "2023-06-01",
  }
  if (options.anthropicBeta) {
    headers["anthropic-beta"] = options.anthropicBeta
  }

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  })

  if (!response.ok) {
    const bodyText = await response.text()
    throw new HTTPError("Failed to create messages", response, bodyText)
  }

  if (options.stream) return events(response)

  return (await response.json()) as TResponse
}
