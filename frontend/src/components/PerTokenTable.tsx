import type { PerTokenRow } from "../types"

function fmt(ms: number | null): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString()
}

export function PerTokenTable(props: { rows: Array<PerTokenRow> }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Token</th>
          <th>Requests</th>
          <th>Tokens</th>
          <th>Monthly %</th>
          <th>Last used</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td>{r.requests.toLocaleString()}</td>
            <td>{r.tokens.toLocaleString()}</td>
            <td>{r.monthly_pct === null ? "—" : `${r.monthly_pct}%`}</td>
            <td>{fmt(r.last_used_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
