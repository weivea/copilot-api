import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { api } from "../api/client"
import { useAuth } from "../contexts/AuthContext"

const TTL_KEY = "cpk_preferred_ttl"

export function Login() {
  const { refresh } = useAuth()
  const nav = useNavigate()
  const [keyInput, setKeyInput] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const ttl = Number.parseInt(
      globalThis.localStorage.getItem(TTL_KEY) ?? "1",
      10,
    )
    try {
      await api.login(keyInput, [1, 30, 7].includes(ttl) ? ttl : 1)
      await refresh()
      nav("/overview", { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <form
        onSubmit={submit}
        style={{
          background: "var(--panel)",
          padding: 24,
          borderRadius: 8,
          border: "1px solid var(--border)",
          minWidth: 360,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Copilot API Dashboard</h2>
        <div className="field">
          <label>Auth token</label>
          <input
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="cpk-…"
            autoFocus
          />
        </div>
        {error && (
          <div className="error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        <button className="primary" disabled={busy || !keyInput}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  )
}
