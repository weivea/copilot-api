import type {
  CreatedToken,
  DeviceFlowStart,
  DeviceFlowState,
  GithubAuthStatus,
  MeResponse,
  PerTokenRow,
  RecentLog,
  TimeseriesPoint,
  TokenRow,
  UsageSummary,
} from "../types"

const BASE = "/admin/api"

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${text}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  login: (key: string, ttlDays: number) =>
    request<MeResponse>("/login", {
      method: "POST",
      body: JSON.stringify({ key, ttl_days: ttlDays }),
    }),
  logout: () => request<void>("/logout", { method: "POST" }),
  me: () => request<MeResponse>("/me"),

  listTokens: () => request<Array<TokenRow>>("/tokens"),
  createToken: (input: {
    name: string
    is_admin?: boolean
    rpm_limit?: number | null
    monthly_token_limit?: number | null
    lifetime_token_limit?: number | null
  }) =>
    request<CreatedToken>("/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patchToken: (id: number, patch: Partial<TokenRow>) =>
    request<TokenRow>(`/tokens/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteToken: (id: number) =>
    request<void>(`/tokens/${id}`, { method: "DELETE" }),
  resetMonthly: (id: number) =>
    request<void>(`/tokens/${id}/reset-monthly`, { method: "POST" }),
  resetLifetime: (id: number) =>
    request<void>(`/tokens/${id}/reset-lifetime`, { method: "POST" }),
  rotateToken: (id: number) =>
    request<CreatedToken>(`/tokens/${id}/rotate`, { method: "POST" }),

  summary: (tokenId: number | "me" | "all") =>
    request<UsageSummary>(`/usage/summary?token_id=${tokenId}`),
  timeseries: (params: {
    tokenId: number | "me" | "all"
    from: number
    to: number
    bucket: string
  }) =>
    request<Array<TimeseriesPoint>>(
      `/usage/timeseries?token_id=${params.tokenId}&from=${params.from}&to=${params.to}&bucket=${params.bucket}`,
    ),
  perToken: (from: number, to: number) =>
    request<Array<PerTokenRow>>(`/usage/per-token?from=${from}&to=${to}`),
  recent: (tokenId: number | "me" | "all", limit = 50) =>
    request<Array<RecentLog>>(
      `/usage/recent?token_id=${tokenId}&limit=${limit}`,
    ),

  githubStatus: () => request<GithubAuthStatus>("/github/status"),
  startGithubFlow: () =>
    request<DeviceFlowStart>("/github/device-flow/start", {
      method: "POST",
      body: "{}",
    }),
  getGithubFlow: (id: string) =>
    request<DeviceFlowState>(`/github/device-flow/${id}`),
  cancelGithubFlow: (id: string) =>
    request<{ ok: true }>(`/github/device-flow/${id}/cancel`, {
      method: "POST",
    }),
  githubLogout: () =>
    request<{ ok: true }>("/github/logout", { method: "POST" }),
}
