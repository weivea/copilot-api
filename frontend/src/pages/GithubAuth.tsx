import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import type {
  DeviceFlowStart,
  DeviceFlowState,
  GithubAuthStatus,
} from "../types"

import { api } from "../api/client"

type View =
  | { kind: "idle" }
  | { kind: "active"; flow: DeviceFlowStart; state: DeviceFlowState }
  | { kind: "result"; state: DeviceFlowState }

const copy = (text: string) => {
  void navigator.clipboard.writeText(text)
}

export function GithubAuth() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<GithubAuthStatus | null>(null)
  const [view, setView] = useState<View>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshStatus = async () => {
    try {
      setStatus(await api.githubStatus())
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void refreshStatus()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const startFlow = async () => {
    setError(null)
    try {
      const flow = await api.startGithubFlow()
      const initial: DeviceFlowState = {
        status: "pending",
        error: null,
        login: null,
        expiresAt: Date.now() + flow.expires_in * 1000,
      }
      setView({ kind: "active", flow, state: initial })
      const intervalMs = Math.max(2, flow.interval) * 1000
      pollRef.current = setInterval(async () => {
        try {
          const next = await api.getGithubFlow(flow.flow_id)
          setView((v) => (v.kind === "active" ? { ...v, state: next } : v))
          if (next.status !== "pending") {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setView({ kind: "result", state: next })
            await refreshStatus()
            if (next.status === "success") {
              setTimeout(() => navigate("/overview"), 2000)
            }
          }
        } catch (e) {
          setError(String(e))
        }
      }, intervalMs)
    } catch (e) {
      setError(String(e))
    }
  }

  const cancel = async () => {
    if (view.kind !== "active") return
    await api.cancelGithubFlow(view.flow.flow_id)
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
    setView({ kind: "idle" })
    await refreshStatus()
  }

  const logout = async () => {
    if (
      !globalThis.confirm(
        "Disconnect GitHub? Copilot endpoints will stop working until you sign in again.",
      )
    )
      return
    await api.githubLogout()
    await refreshStatus()
  }

  return (
    <div className="page">
      <h1>GitHub Authentication</h1>

      {status && (
        <div className="card">
          <div>
            <strong>GitHub:</strong>{" "}
            {status.hasToken ?
              `Connected as ${status.login ?? "(unknown)"}`
            : "Not connected"}
          </div>
          <div>
            <strong>Copilot:</strong>{" "}
            {status.copilotReady ? "Ready" : "Unavailable"}
          </div>
          {status.hasToken && (
            <button onClick={logout}>Disconnect GitHub</button>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {view.kind === "idle" && (
        <button onClick={startFlow}>
          {status?.hasToken ? "Re-authenticate GitHub" : "Sign in to GitHub"}
        </button>
      )}

      {view.kind === "active" && (
        <div className="card">
          <p>Enter this code on GitHub. This page will update automatically.</p>
          <div className="user-code">
            <code style={{ fontSize: "2rem", letterSpacing: "0.2em" }}>
              {view.flow.user_code}
            </code>
            <button onClick={() => copy(view.flow.user_code)}>Copy</button>
          </div>
          <a
            href={
              view.flow.verification_uri_complete ?? view.flow.verification_uri
            }
            target="_blank"
            rel="noreferrer"
          >
            <button>Open GitHub</button>
          </a>
          <button onClick={cancel}>Cancel</button>
        </div>
      )}

      {view.kind === "result" && (
        <div className="card">
          {view.state.status === "success" && (
            <div>Signed in as {view.state.login}. Redirecting…</div>
          )}
          {view.state.status !== "success" && (
            <>
              <div>
                Login {view.state.status}: {view.state.error}
              </div>
              <button onClick={() => setView({ kind: "idle" })}>
                Try again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
