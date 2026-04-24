import { useEffect, useMemo, useState } from "react"

import type { ModelInfo } from "../types"

import { api } from "../api/client"

type SortKey = "id" | "vendor" | "context" | "output"

function formatNumber(n: number | undefined): string {
  if (n === undefined) return "—"
  return n.toLocaleString()
}

function badge(text: string, tone: "ok" | "muted" | "warn") {
  return <span className={`models-badge models-badge--${tone}`}>{text}</span>
}

function copyId(id: string) {
  void navigator.clipboard.writeText(id)
}

export function Models() {
  const [models, setModels] = useState<Array<ModelInfo> | null>(null)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("id")
  const [vendor, setVendor] = useState<string>("")

  const load = () => {
    setError(null)
    api
      .listModels()
      .then((res) => {
        setAvailable(res.available)
        setModels(res.data)
      })
      .catch((e: unknown) => {
        setError(String(e))
        setModels([])
      })
  }

  useEffect(() => {
    load()
  }, [])

  const vendors = useMemo(() => {
    if (!models) return []
    return [...new Set(models.map((m) => m.vendor))].sort((a, b) =>
      a.localeCompare(b),
    )
  }, [models])

  const visible = useMemo(() => {
    if (!models) return []
    const f = filter.trim().toLowerCase()
    let rows = models.filter((m) => {
      if (vendor && m.vendor !== vendor) return false
      if (!f) return true
      const family = m.capabilities?.family ?? ""
      return (
        m.id.toLowerCase().includes(f)
        || m.name.toLowerCase().includes(f)
        || m.vendor.toLowerCase().includes(f)
        || family.toLowerCase().includes(f)
      )
    })
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "vendor": {
          return a.vendor.localeCompare(b.vendor) || a.id.localeCompare(b.id)
        }
        case "context": {
          return (
            (b.capabilities?.limits?.max_context_window_tokens ?? 0)
            - (a.capabilities?.limits?.max_context_window_tokens ?? 0)
          )
        }
        case "output": {
          return (
            (b.capabilities?.limits?.max_output_tokens ?? 0)
            - (a.capabilities?.limits?.max_output_tokens ?? 0)
          )
        }
        default: {
          return a.id.localeCompare(b.id)
        }
      }
    })
    return rows
  }, [models, filter, vendor, sortKey])

  if (models === null) {
    return (
      <div className="page">
        <h1>Models</h1>
        <p className="muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="page models-page">
      <h1>Models</h1>
      <p className="muted">
        Models reported by your GitHub Copilot account. Use the <code>id</code>{" "}
        column when configuring an OpenAI- or Anthropic-compatible client. The
        list is cached at startup and refreshed after GitHub login.
      </p>

      {!available && (
        <div className="banner banner--warn">
          GitHub not connected — model list is empty. A super admin can sign in
          at <a href="/github-auth">/github-auth</a>.
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <input
          type="text"
          placeholder="Filter by id, name, vendor, family…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          <option value="id">Sort: id</option>
          <option value="vendor">Sort: vendor</option>
          <option value="context">Sort: context window</option>
          <option value="output">Sort: max output</option>
        </select>
        <button onClick={load} type="button">
          Reload
        </button>
        <span className="muted small">
          {visible.length} / {models.length} shown
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Vendor</th>
            <th>Family</th>
            <th style={{ textAlign: "right" }}>Context</th>
            <th style={{ textAlign: "right" }}>Max output</th>
            <th>Capabilities</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="models-id">
                  <code>{m.id}</code>
                  <button
                    className="docs-copy models-id-copy"
                    type="button"
                    onClick={() => copyId(m.id)}
                  >
                    Copy
                  </button>
                </div>
              </td>
              <td>{m.name}</td>
              <td>{m.vendor}</td>
              <td>{m.capabilities?.family ?? "—"}</td>
              <td style={{ textAlign: "right" }}>
                {formatNumber(m.capabilities?.limits?.max_context_window_tokens)}
              </td>
              <td style={{ textAlign: "right" }}>
                {formatNumber(m.capabilities?.limits?.max_output_tokens)}
              </td>
              <td>
                <div className="models-badges">
                  {m.capabilities?.type && badge(m.capabilities.type, "muted")}
                  {m.preview && badge("preview", "warn")}
                  {m.capabilities?.supports?.tool_calls
                    && badge("tools", "ok")}
                  {m.capabilities?.supports?.parallel_tool_calls
                    && badge("parallel", "ok")}
                  {m.capabilities?.supports?.dimensions
                    && badge("dimensions", "ok")}
                  {!m.model_picker_enabled && badge("hidden", "muted")}
                </div>
              </td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="muted" style={{ textAlign: "center" }}>
                No models match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
