import { useEffect, useMemo, useState } from "react"

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
import type {
  PerTokenRow,
  RecentLog,
  TimeseriesPoint,
  TokenRow,
} from "../types"

type Selection = "me" | "all" | number

export function Usage() {
  const { me } = useAuth()
  const [tokens, setTokens] = useState<Array<TokenRow>>([])
  const [selection, setSelection] = useState<Selection>("me")
  const [range, setRange] = useState<Range>(
    rangeFromPreset({ days: 7 }),
  )
  const [metric, setMetric] = useState<"requests" | "tokens">("requests")
  const [series, setSeries] = useState<Array<TimeseriesPoint>>([])
  const [perToken, setPerToken] = useState<Array<PerTokenRow>>([])
  const [recent, setRecent] = useState<Array<RecentLog>>([])
  const [error, setError] = useState<string | null>(null)

  const isAdmin = me?.role === "admin" || me?.role === "super"

  useEffect(() => {
    if (!isAdmin) return
    api.listTokens().then(setTokens).catch((e) => setError((e as Error).message))
  }, [isAdmin])

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

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ flex: 1, margin: 0 }}>Usage</h2>
        {isAdmin && (
          <select
            value={String(selection)}
            onChange={(e) => {
              const v = e.target.value
              setSelection(v === "me" || v === "all" ? v : Number.parseInt(v, 10))
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
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as "requests" | "tokens")}
        >
          <option value="requests">Requests</option>
          <option value="tokens">Tokens</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <TrendChart
          data={series}
          metric={metric}
          stacked={selection === "all"}
          tokenNames={tokenNames}
        />
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
          {recent.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.timestamp).toLocaleString()}</td>
              <td>{r.endpoint}</td>
              <td>{r.model ?? "—"}</td>
              <td>{r.statusCode}</td>
              <td>{r.totalTokens?.toLocaleString() ?? "—"}</td>
              <td>{r.latencyMs ? `${r.latencyMs}ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
