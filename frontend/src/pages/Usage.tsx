import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"

import type {
  GithubAuthStatus,
  PerTokenRow,
  RecentLog,
  TimeseriesPoint,
  TokenRow,
  UsageBreakdown,
  UsageSummary,
} from "../types"

import { api } from "../api/client"
import { PerTokenTable } from "../components/PerTokenTable"
import {
  rangeFromPreset,
  TimeRangePicker,
  type Range,
} from "../components/TimeRangePicker"
import { TrendChart } from "../components/TrendChart"
import { useAuth } from "../contexts/AuthContext"
import { suggestBucket } from "../lib/bucket"

type Selection = "me" | "all" | number

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  )
}

function pct(used: number, limit: number | null): string {
  if (!limit) return "—"
  return `${Math.min(100, Math.round((used / limit) * 100))}%`
}

function fmtBreakdownDetail(
  val: number | null | undefined,
  requests: number,
): string {
  if (requests === 0) return "—"
  if (val === null || val === undefined) return "未知"
  return val.toLocaleString()
}

function fmtHitRate(rate: number | null | undefined, requests: number): string {
  if (requests === 0) return "—"
  if (rate === null || rate === undefined) return "未知"
  return `${rate}%`
}

function fmtRowCount(val: number | null | undefined): string {
  if (val === null || val === undefined) return "—"
  return val.toLocaleString()
}

function fmtRowSubdetail(
  val: number | null | undefined,
  hasAnyUsage: boolean,
): string {
  if (!hasAnyUsage) return "—"
  if (val === null || val === undefined) return "未知"
  return val.toLocaleString()
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function RangeBreakdownSection({ breakdown }: { breakdown: UsageBreakdown }) {
  return (
    <div style={{ marginBottom: 16, overflowX: "auto" }}>
      <h3>区间用量明细</h3>
      <table>
        <thead>
          <tr>
            <th>总输入</th>
            <th>其中缓存命中</th>
            <th>缓存写入</th>
            <th>总输出</th>
            <th>其中思考</th>
            <th>总 token</th>
            <th>额度扣减</th>
            <th>缓存命中率</th>
            <th>用量不完整请求</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{breakdown.prompt_tokens.toLocaleString()}</td>
            <td>
              {fmtBreakdownDetail(breakdown.cached_tokens, breakdown.requests)}
            </td>
            <td>
              {fmtBreakdownDetail(
                breakdown.cache_creation_tokens,
                breakdown.requests,
              )}
            </td>
            <td>{breakdown.completion_tokens.toLocaleString()}</td>
            <td>
              {fmtBreakdownDetail(
                breakdown.reasoning_tokens,
                breakdown.requests,
              )}
            </td>
            <td>{breakdown.total_tokens.toLocaleString()}</td>
            <td>{breakdown.billable_tokens.toLocaleString()}</td>
            <td>{fmtHitRate(breakdown.cache_hit_rate, breakdown.requests)}</td>
            <td>{breakdown.incomplete_requests.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function RecentRequestRow({ r }: { r: RecentLog }) {
  const nonBillable = r.endpoint === "/v1/messages/count_tokens"
  const incomplete = r.usageComplete === 0
  const hasAnyUsage =
    !nonBillable
    && (r.promptTokens !== null
      || r.completionTokens !== null
      || r.totalTokens !== null)
  const billable = r.billableTokens ?? (nonBillable ? 0 : r.totalTokens)
  return (
    <tr>
      <td>{new Date(r.timestamp).toLocaleString()}</td>
      <td>
        {r.endpoint}
        {nonBillable && (
          <span
            title="本地估算端点，不消耗 Copilot 配额，不计入用量统计"
            style={{
              marginLeft: 6,
              padding: "1px 6px",
              borderRadius: 4,
              fontSize: 11,
              background: "#3a3f4b",
              color: "#cfd3dc",
              border: "1px solid #4a4f5b",
              verticalAlign: "middle",
            }}
          >
            不计费
          </span>
        )}
        {incomplete && (
          <span
            title="流中断或缺少最终 usage，未按零或估算值冒充完整用量"
            style={{
              marginLeft: 6,
              padding: "1px 6px",
              borderRadius: 4,
              fontSize: 11,
              background: "#4b3d24",
              color: "#f6c977",
              border: "1px solid #6b5632",
              verticalAlign: "middle",
            }}
          >
            用量不完整
          </span>
        )}
      </td>
      <td>{r.model ?? "—"}</td>
      <td>{r.statusCode}</td>
      <td>{fmtRowCount(r.promptTokens)}</td>
      <td>{fmtRowSubdetail(r.cachedTokens, hasAnyUsage)}</td>
      <td>{fmtRowSubdetail(r.cacheCreationTokens, hasAnyUsage)}</td>
      <td>{fmtRowCount(r.completionTokens)}</td>
      <td>{fmtRowSubdetail(r.reasoningTokens, hasAnyUsage)}</td>
      <td>{fmtRowCount(r.totalTokens)}</td>
      <td>{fmtRowCount(billable)}</td>
      <td>{r.latencyMs !== null ? `${r.latencyMs}ms` : "—"}</td>
    </tr>
  )
}

function RecentRequestsTable({ recent }: { recent: Array<RecentLog> }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Endpoint</th>
            <th>Model</th>
            <th>Status</th>
            <th>总输入</th>
            <th>其中缓存命中</th>
            <th>缓存写入</th>
            <th>总输出</th>
            <th>其中思考</th>
            <th>总 token</th>
            <th>额度扣减</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((r) => (
            <RecentRequestRow key={r.id} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function fmtLimitPair(used: number, limit: number | null): string {
  return limit ?
      `${used.toLocaleString()} / ${limit.toLocaleString()}`
    : used.toLocaleString()
}

function UsageSummaryCards({
  rangeTotals,
  summary,
}: {
  rangeTotals: { requests: number; tokens: number }
  summary: UsageSummary | null
}) {
  const rb = summary?.range_breakdown
  return (
    <div className="cards" style={{ marginBottom: 16 }}>
      <SummaryCard
        label="Requests in range"
        value={rangeTotals.requests.toLocaleString()}
      />
      <SummaryCard
        label="额度扣减 (Range)"
        value={rangeTotals.tokens.toLocaleString()}
      />
      <SummaryCard
        label="缓存命中率 (Range)"
        value={rb ? fmtHitRate(rb.cache_hit_rate, rb.requests) : "—"}
      />
      <SummaryCard
        label="Monthly used"
        value={
          summary ?
            fmtLimitPair(summary.monthly_used, summary.monthly_limit)
          : "—"
        }
      />
      <SummaryCard
        label="Monthly %"
        value={summary ? pct(summary.monthly_used, summary.monthly_limit) : "—"}
      />
      <SummaryCard
        label="Lifetime used"
        value={
          summary ?
            fmtLimitPair(summary.lifetime_used, summary.lifetime_limit)
          : "—"
        }
      />
    </div>
  )
}

export function Usage() {
  const { me } = useAuth()
  const [tokens, setTokens] = useState<Array<TokenRow>>([])
  const [selection, setSelection] = useState<Selection>("me")
  const [range, setRange] = useState<Range>(rangeFromPreset({ days: 7 }))
  const [series, setSeries] = useState<Array<TimeseriesPoint>>([])
  const [perToken, setPerToken] = useState<Array<PerTokenRow>>([])
  const [recent, setRecent] = useState<Array<RecentLog>>([])
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [gh, setGh] = useState<GithubAuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isAdmin = me?.role === "admin" || me?.role === "super"

  useEffect(() => {
    if (!isAdmin) return
    api
      .listTokens()
      .then(setTokens)
      .catch((e: unknown) => setError(errMessage(e)))
  }, [isAdmin])

  useEffect(() => {
    api
      .githubStatus()
      .then(setGh)
      .catch(() => setGh(null))
  }, [])

  const bucket = useMemo(
    () => suggestBucket(range.from, range.to),
    [range.from, range.to],
  )

  useEffect(() => {
    setError(null)
    api
      .timeseries({
        tokenId: selection,
        from: range.from,
        to: range.to,
        bucket,
      })
      .then(setSeries)
      .catch((e: unknown) => setError(errMessage(e)))
    api
      .recent(selection)
      .then(setRecent)
      .catch((e: unknown) => setError(errMessage(e)))
    api
      .summary(selection, range.from, range.to)
      .then(setSummary)
      .catch((e: unknown) => setError(errMessage(e)))
    if (isAdmin && selection === "all") {
      api
        .perToken(range.from, range.to)
        .then(setPerToken)
        .catch((e: unknown) => setError(errMessage(e)))
    } else {
      setPerToken([])
    }
  }, [selection, range.from, range.to, bucket, isAdmin])

  const tokenNames = useMemo(() => {
    const map: Record<number, string> = {}
    for (const t of tokens) map[t.id] = t.name
    return map
  }, [tokens])

  const rangeTotals = useMemo(() => {
    let requests = 0
    let tokensSum = 0
    for (const p of series) {
      requests += p.requests
      tokensSum += p.tokens
    }
    return { requests, tokens: tokensSum }
  }, [series])

  const rb = summary?.range_breakdown
  const showBanner = Boolean(gh && !gh.copilotReady)

  return (
    <div>
      {showBanner && (
        <div className="banner banner--warn">
          GitHub not connected — Copilot endpoints disabled.{" "}
          {me?.role === "super" ?
            <Link to="/github-auth">Sign in</Link>
          : <span>Contact a super admin.</span>}
        </div>
      )}
      <div className="toolbar">
        <h2 style={{ flex: 1, margin: 0 }}>Usage</h2>
        {isAdmin && (
          <select
            value={String(selection)}
            onChange={(e) => {
              const v = e.target.value
              setSelection(
                v === "me" || v === "all" ? v : Number.parseInt(v, 10),
              )
            }}
          >
            <option value="me">Me</option>
            <option value="all">All tokens</option>
            {tokens.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <TimeRangePicker value={range} onChange={setRange} />
      </div>
      {error && <div className="error">{error}</div>}
      <UsageSummaryCards rangeTotals={rangeTotals} summary={summary} />
      {rb && <RangeBreakdownSection breakdown={rb} />}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Requests</h3>
          <TrendChart
            data={series}
            metric="requests"
            stacked={selection === "all"}
            tokenNames={tokenNames}
          />
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Tokens</h3>
          <TrendChart
            data={series}
            metric="tokens"
            stacked={selection === "all"}
            tokenNames={tokenNames}
          />
        </div>
      </div>
      {selection === "all" && perToken.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3>Per-token</h3>
          <PerTokenTable rows={perToken} />
        </div>
      )}
      <h3>Recent requests</h3>
      <RecentRequestsTable recent={recent} />
    </div>
  )
}

export default Usage
