import { GITHUB_API_BASE_URL, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get Copilot token", response)

  return (await response.json()) as GetCopilotTokenResponse
}

export interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
    "origin-tracker"?: string
    proxy?: string
    telemetry?: string
  }
  individual?: boolean
  sku?: string
}
