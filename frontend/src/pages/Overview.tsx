import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import type { GithubAuthStatus, UsageSummary } from "../types"

import { api } from "../api/client"
import { useAuth } from "../contexts/AuthContext"

function Card({ label, value }: { label: string; value: string }) {
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

export function Overview() {
  const { me } = useAuth()
  const [s, setS] = useState<UsageSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [gh, setGh] = useState<GithubAuthStatus | null>(null)

  useEffect(() => {
    if (!me) return
    const tokenId =
      me.role === "super" ? "all"
      : me.role === "admin" ? "all"
      : "me"
    api
      .summary(tokenId)
      .then(setS)
      .catch((e) => setErr((e as Error).message))
  }, [me])

  useEffect(() => {
    api
      .githubStatus()
      .then(setGh)
      .catch(() => setGh(null))
  }, [])

  const banner =
    gh && !gh.copilotReady ?
      <div className="banner banner--warn">
        GitHub not connected — Copilot endpoints disabled.{" "}
        {me?.role === "super" ?
          <Link to="/github-auth">Sign in</Link>
        : <span>Contact a super admin.</span>}
      </div>
    : null

  if (!me) return null
  if (err) return <div className="error">{err}</div>
  if (!s) return <div>Loading…</div>

  return (
    <div>
      {banner}
      <h2>Overview</h2>
      <div className="cards">
        <Card
          label="Requests today"
          value={s.requests_today.toLocaleString()}
        />
        <Card label="Tokens today" value={s.tokens_today.toLocaleString()} />
        <Card
          label="Monthly used"
          value={`${s.monthly_used.toLocaleString()}${s.monthly_limit ? " / " + s.monthly_limit.toLocaleString() : ""}`}
        />
        <Card label="Monthly %" value={pct(s.monthly_used, s.monthly_limit)} />
        <Card
          label="Lifetime used"
          value={`${s.lifetime_used.toLocaleString()}${s.lifetime_limit ? " / " + s.lifetime_limit.toLocaleString() : ""}`}
        />
      </div>
    </div>
  )
}
