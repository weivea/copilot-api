import { useEffect, useMemo, useState } from "react"

import type { ModelInfo } from "../types"

import { api } from "../api/client"

type SortKey = "id" | "vendor" | "context" | "output" | "category"

const CATEGORY_ORDER: Record<string, number> = {
  powerful: 0,
  versatile: 1,
  lightweight: 2,
}

function formatNumber(n: number | undefined): string {
  if (n === undefined) return "—"
  return n.toLocaleString()
}

function badge(text: string, tone: "ok" | "muted" | "warn" | "info") {
  return <span className={`models-badge models-badge--${tone}`}>{text}</span>
}

function copyId(id: string) {
  void navigator.clipboard.writeText(id)
}

function categoryBadge(cat: string | undefined) {
  if (!cat) return <>—</>
  const tone =
    cat === "powerful" ? "info"
    : cat === "lightweight" ? "muted"
    : "ok"
  return badge(cat, tone)
}

function endpointShort(ep: string): string {
  if (ep === "/v1/messages") return "messages"
  if (ep === "/chat/completions") return "chat"
  if (ep === "/responses") return "responses"
  if (ep.startsWith("ws:")) return ep.slice(3)
  return ep.replace(/^\//, "")
}

export function Models() {
  const [models, setModels] = useState<Array<ModelInfo> | null>(null)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("category")
  const [vendor, setVendor] = useState<string>("")
  const [type, setType] = useState<string>("")
  const [showHidden, setShowHidden] = useState(false)

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
    return [...new Set(models.map((m) => m.vendor).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b),
    )
  }, [models])

  const types = useMemo(() => {
    if (!models) return []
    return [
      ...new Set(models.map((m) => m.capabilities?.type ?? "").filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b))
  }, [models])

  const visible = useMemo(() => {
    if (!models) return []
    const f = filter.trim().toLowerCase()
    let rows = models.filter((m) => {
      if (vendor && m.vendor !== vendor) return false
      if (type && m.capabilities?.type !== type) return false
      if (!showHidden && !m.model_picker_enabled) return false
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
        case "category": {
          const ac = CATEGORY_ORDER[a.model_picker_category ?? ""] ?? 99
          const bc = CATEGORY_ORDER[b.model_picker_category ?? ""] ?? 99
          return ac - bc || a.id.localeCompare(b.id)
        }
        default: {
          return a.id.localeCompare(b.id)
        }
      }
    })
    return rows
  }, [models, filter, vendor, type, sortKey, showHidden])

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
        column when configuring an OpenAI- or Anthropic-compatible client.
        Hidden entries are duplicates / aliases / deprecated models that Copilot
        keeps for compatibility — toggle them on if you need to look one up.
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
          style={{ minWidth: 260 }}
        />
        <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          <option value="category">Sort: category</option>
          <option value="id">Sort: id</option>
          <option value="vendor">Sort: vendor</option>
          <option value="context">Sort: context window</option>
          <option value="output">Sort: max output</option>
        </select>
        <label className="models-toggle">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
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
            <th>Type</th>
            <th>Category</th>
            <th style={{ textAlign: "right" }}>Context</th>
            <th style={{ textAlign: "right" }}>Max output</th>
            <th>Endpoints</th>
            <th>Capabilities</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((m) => {
            const supports = m.capabilities?.supports ?? {}
            return (
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
                <td>{m.vendor || "—"}</td>
                <td>{m.capabilities?.type ?? "—"}</td>
                <td>{categoryBadge(m.model_picker_category)}</td>
                <td style={{ textAlign: "right" }}>
                  {formatNumber(
                    m.capabilities?.limits?.max_context_window_tokens,
                  )}
                </td>
                <td style={{ textAlign: "right" }}>
                  {formatNumber(m.capabilities?.limits?.max_output_tokens)}
                </td>
                <td>
                  <div className="models-badges">
                    {(m.supported_endpoints ?? []).map((ep) => (
                      <span
                        key={ep}
                        className="models-badge models-badge--muted"
                      >
                        {endpointShort(ep)}
                      </span>
                    ))}
                    {!m.supported_endpoints && (
                      <span className="muted small">—</span>
                    )}
                  </div>
                </td>
                <td>
                  <div className="models-badges">
                    {m.preview && badge("preview", "warn")}
                    {!m.model_picker_enabled && badge("hidden", "muted")}
                    {supports.streaming && badge("stream", "ok")}
                    {supports.tool_calls && badge("tools", "ok")}
                    {supports.parallel_tool_calls && badge("parallel", "ok")}
                    {supports.vision && badge("vision", "ok")}
                    {supports.structured_outputs && badge("structured", "ok")}
                    {supports.adaptive_thinking && badge("thinking", "info")}
                    {supports.reasoning_effort
                      && supports.reasoning_effort.length > 0
                      && badge(
                        `effort:${supports.reasoning_effort.length}`,
                        "info",
                      )}
                    {supports.dimensions && badge("dimensions", "ok")}
                  </div>
                </td>
              </tr>
            )
          })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={9} className="muted" style={{ textAlign: "center" }}>
                No models match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
