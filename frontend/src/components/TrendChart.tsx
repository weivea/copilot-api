import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { TimeseriesPoint } from "../types"

export function TrendChart(props: {
  data: Array<TimeseriesPoint>
  metric: "requests" | "tokens"
  stacked?: boolean
  tokenNames?: Record<number, string>
}) {
  if (!props.stacked) {
    const flat = props.data.map((d) => ({
      t: d.bucketStart,
      v: d[props.metric],
    }))
    return (
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={flat}>
          <CartesianGrid stroke="#2a2f3a" />
          <XAxis
            dataKey="t"
            tickFormatter={(v) => new Date(v).toLocaleDateString()}
            stroke="#8b93a7"
          />
          <YAxis stroke="#8b93a7" />
          <Tooltip
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            contentStyle={{ background: "#161a22", border: "1px solid #2a2f3a" }}
          />
          <Area dataKey="v" stroke="#4f8cff" fill="#4f8cff44" />
        </AreaChart>
      </ResponsiveContainer>
    )
  }
  // Stacked by token: pivot
  const tokenIds = Array.from(
    new Set(props.data.map((d) => d.authTokenId ?? 0)),
  )
  const buckets = Array.from(new Set(props.data.map((d) => d.bucketStart))).sort(
    (a, b) => a - b,
  )
  const rows = buckets.map((b) => {
    const row: Record<string, number> = { t: b }
    for (const id of tokenIds) {
      const match = props.data.find(
        (d) => d.bucketStart === b && (d.authTokenId ?? 0) === id,
      )
      row[`tok_${id}`] = match ? match[props.metric] : 0
    }
    return row
  })
  const palette = ["#4f8cff", "#ff8a4c", "#4caf50", "#c66cff", "#ffd54f"]
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={rows}>
        <CartesianGrid stroke="#2a2f3a" />
        <XAxis
          dataKey="t"
          tickFormatter={(v) => new Date(v).toLocaleDateString()}
          stroke="#8b93a7"
        />
        <YAxis stroke="#8b93a7" />
        <Tooltip
          labelFormatter={(v) => new Date(v as number).toLocaleString()}
          contentStyle={{ background: "#161a22", border: "1px solid #2a2f3a" }}
        />
        {tokenIds.map((id, i) => (
          <Area
            key={id}
            type="monotone"
            dataKey={`tok_${id}`}
            stackId="1"
            stroke={palette[i % palette.length]}
            fill={palette[i % palette.length] + "44"}
            name={props.tokenNames?.[id] ?? `token ${id}`}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}
