import type { PerTokenRow } from "../types"

function fmtTime(ms: number | null): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString()
}

function fmtKnownOrUnknown(
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

export function PerTokenTable(props: { rows: Array<PerTokenRow> }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Requests</th>
            <th>总输入</th>
            <th>其中缓存命中</th>
            <th>缓存写入</th>
            <th>总输出</th>
            <th>其中思考</th>
            <th>总 token</th>
            <th>额度扣减</th>
            <th>缓存命中率</th>
            <th>Monthly %</th>
            <th>Last used</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.name}
                {r.incomplete_requests > 0 && (
                  <span
                    title={`该区间内有 ${r.incomplete_requests} 次请求流中断或缺少最终 usage`}
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
                    不完整 ×{r.incomplete_requests}
                  </span>
                )}
              </td>
              <td>{r.requests.toLocaleString()}</td>
              <td>{r.prompt_tokens.toLocaleString()}</td>
              <td>{fmtKnownOrUnknown(r.cached_tokens, r.requests)}</td>
              <td>{fmtKnownOrUnknown(r.cache_creation_tokens, r.requests)}</td>
              <td>{r.completion_tokens.toLocaleString()}</td>
              <td>{fmtKnownOrUnknown(r.reasoning_tokens, r.requests)}</td>
              <td>{r.total_tokens.toLocaleString()}</td>
              <td>{r.billable_tokens.toLocaleString()}</td>
              <td>{fmtHitRate(r.cache_hit_rate, r.requests)}</td>
              <td>{r.monthly_pct === null ? "—" : `${r.monthly_pct}%`}</td>
              <td>{fmtTime(r.last_used_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
