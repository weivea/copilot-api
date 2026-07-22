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
  agent_mode_auto_approval?: boolean
  annotations_enabled?: boolean
  azure_only?: boolean
  blackbird_clientside_indexing?: boolean
  blackbird_external_indexing?: boolean
  chat_enabled?: boolean
  chat_jetbrains_enabled?: boolean
  code_quote_enabled?: boolean
  code_review_enabled?: boolean
  codesearch?: boolean
  copilotignore_enabled?: boolean
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
    "origin-tracker"?: string
    proxy?: string
    telemetry?: string
  }
  enterprise_list?: Array<string>
  individual?: boolean
  limited_user_quotas?: Record<string, unknown>
  limited_user_reset_date?: string | null
  organization_list?: Array<string>
  public_suggestions?: string
  sku?: string
  telemetry?: string
  tracking_id?: string
}
