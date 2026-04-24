export type Role = "super" | "admin" | "user"

export interface MeResponse {
  role: Role
  authTokenId: number | null
  name: string
}

export interface TokenRow {
  id: number
  name: string
  token_prefix: string
  is_admin: boolean
  is_disabled: boolean
  rpm_limit: number | null
  monthly_token_limit: number | null
  lifetime_token_limit: number | null
  lifetime_token_used: number
  created_at: number
  last_used_at: number | null
  is_super_admin?: boolean
}

export interface CreatedToken extends TokenRow {
  token: string
}

export interface UsageSummary {
  requests_today: number
  tokens_today: number
  monthly_used: number
  monthly_limit: number | null
  lifetime_used: number
  lifetime_limit: number | null
}

export interface TimeseriesPoint {
  bucketStart: number
  requests: number
  tokens: number
  authTokenId: number | null
}

export interface PerTokenRow {
  id: number
  name: string
  requests: number
  tokens: number
  monthly_pct: number | null
  last_used_at: number | null
}

export interface RecentLog {
  id: number
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  statusCode: number
  latencyMs: number | null
}

export type Bucket = "hour" | "day" | "week" | "month"

export interface GithubAuthStatus {
  hasToken: boolean
  login: string | null
  copilotReady: boolean
  activeFlow: { id: string; expiresAt: number } | null
}

export interface DeviceFlowStart {
  flow_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string | null
  expires_in: number
  interval: number
}

export type DeviceFlowStatus =
  | "pending"
  | "success"
  | "error"
  | "expired"
  | "cancelled"

export interface DeviceFlowState {
  status: DeviceFlowStatus
  error: string | null
  login: string | null
  expiresAt: number
}

export interface ModelInfo {
  id: string
  name: string
  vendor: string
  version: string
  preview: boolean
  model_picker_enabled: boolean
  model_picker_category?: "powerful" | "versatile" | "lightweight"
  object: string
  supported_endpoints?: Array<string>
  capabilities?: {
    family?: string
    object?: string
    tokenizer?: string
    type?: "chat" | "embeddings" | "completion" | string
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_non_streaming_output_tokens?: number
      max_prompt_tokens?: number
      max_inputs?: number
      vision?: {
        max_prompt_image_size?: number
        max_prompt_images?: number
        supported_media_types?: Array<string>
      }
    }
    supports?: {
      tool_calls?: boolean
      parallel_tool_calls?: boolean
      streaming?: boolean
      structured_outputs?: boolean
      vision?: boolean
      dimensions?: boolean
      adaptive_thinking?: boolean
      max_thinking_budget?: number
      min_thinking_budget?: number
      reasoning_effort?: Array<string>
    }
  }
  policy?: { state: string; terms: string }
}

export interface ModelsListResponse {
  available: boolean
  data: Array<ModelInfo>
}
