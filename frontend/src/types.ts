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
