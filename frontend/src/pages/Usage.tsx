import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"

import type {
  GithubAuthStatus,
  PerTokenRow,
  RecentLog,
  TimeseriesPoint,
  TokenRow,
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
      .catch((e) => setError((e as Error).message))
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
      .catch((e) => setError((e as Error).message))
    api
      .recent(selection)
      .then(setRecent)
      .catch((e) => setError((e as Error).message))
    api
      .summary(selection)
      .then(setSummary)
      .catch((e) => setError((e as Error).message))
    if (isAdmin && selection === "all") {
      api
        .perToken(range.from, range.to)
        .then(setPerToken)
        .catch((e) => setError((e as Error).message))
    } else {
      setPerToken([])
    }
  }, [selection, range.from, range.to, bucket, isAdmin])

  const tokenNames = useMemo(() => {
    const map: Record<number, string> = {}
    for (const t of tokens) map[t.id] = t.name
    return map
  }, [tokens])

  // Range-scoped totals derived from the timeseries
  const rangeTotals = useMemo(() => {
    let requests = 0
    let tokensSum = 0
    for (const p of series) {
      requests += p.requests
      tokensSum += p.tokens
    }
    return { requests, tokens: tokensSum }
  }, [series])

  const banner =
    gh && !gh.copilotReady ?
      <div className="banner banner--warn">
        GitHub not connected — Copilot endpoints disabled.{" "}
        {me?.role === "super" ?
          <Link to="/github-auth">Sign in</Link>
        : <span>Contact a super admin.</span>}
      </div>
    : null

  return (
    <div>
      {banner}
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
      <div className="cards" style={{ marginBottom: 16 }}>
        <SummaryCard
          label="Requests in range"
          value={rangeTotals.requests.toLocaleString()}
        />
        <SummaryCard
          label="Tokens in range"
          value={rangeTotals.tokens.toLocaleString()}
        />
        <SummaryCard
          label="Monthly used"
          value={
            summary ?
              `${summary.monthly_used.toLocaleString()}${
                summary.monthly_limit ?
                  " / " + summary.monthly_limit.toLocaleString()
                : ""
              }`
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
              `${summary.lifetime_used.toLocaleString()}${
                summary.lifetime_limit ?
                  " / " + summary.lifetime_limit.toLocaleString()
                : ""
              }`
            : "—"
          }
        />
      </div>
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
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Endpoint</th>
            <th>Model</th>
            <th>Status</th>
            <th>Tokens</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((r) => {
            const nonBillable = r.endpoint === "/v1/messages/count_tokens"
            return (
              <tr key={r.id}>
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
                </td>
                <td>{r.model ?? "—"}</td>
                <td>{r.statusCode}</td>
                <td>{r.totalTokens?.toLocaleString() ?? "—"}</td>
                <td>{r.latencyMs ? `${r.latencyMs}ms` : "—"}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
