import { useCallback, useEffect, useState } from "react"

import { api } from "../api/client"
import type { CertificateInfo } from "../types"

type LoadState =
  | { kind: "loading" }
  | { kind: "data"; info: CertificateInfo }
  | { kind: "error"; message: string }

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function colorForDays(days: number, expired: boolean): string {
  if (expired || days < 7) return "#c0392b" // red
  if (days <= 30) return "#d4a017" // amber
  return "#1f8a4c" // green
}

export function TlsCertificateCard() {
  const [state, setState] = useState<LoadState>({ kind: "loading" })

  const load = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const info = await api.getCertificate()
      setState({ kind: "data", info })
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ margin: 0 }}>TLS Certificate</h3>
        <button onClick={() => void load()} disabled={state.kind === "loading"}>
          Refresh
        </button>
      </div>

      {state.kind === "loading" && <p className="label">Loading…</p>}

      {state.kind === "error" && (
        <p className="label" style={{ color: "#c0392b" }}>
          Failed to load: {state.message}
        </p>
      )}

      {state.kind === "data" && !state.info.configured && (
        <div className="field">
          <p>TLS not configured.</p>
          <p className="label">
            {state.info.hint.replace(
              "./scripts/cert.sh obtain --domain <your-domain>",
              "",
            )}
            <code>./scripts/cert.sh obtain --domain &lt;your-domain&gt;</code>
          </p>
        </div>
      )}

      {state.kind === "data"
        && state.info.configured
        && "error" in state.info && (
          <div className="field">
            <p style={{ color: "#c0392b" }}>
              Unable to read certificate: {state.info.error}
            </p>
            <p className="label">
              Path: <code>{state.info.certPath}</code>
            </p>
          </div>
        )}

      {state.kind === "data"
        && state.info.configured
        && "subject" in state.info && (
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              columnGap: 16,
              rowGap: 4,
              marginTop: 8,
            }}
          >
            <dt>Domain</dt>
            <dd>{state.info.domain ?? "—"}</dd>
            <dt>Subject</dt>
            <dd>
              <code>{state.info.subject}</code>
            </dd>
            <dt>Issuer</dt>
            <dd>{state.info.issuer}</dd>
            <dt>Not Before</dt>
            <dd>{formatDate(state.info.validFrom)}</dd>
            <dt>Not After</dt>
            <dd>{formatDate(state.info.validTo)}</dd>
            <dt>Status</dt>
            <dd
              style={{
                color: colorForDays(
                  state.info.daysRemaining,
                  state.info.expired,
                ),
                fontWeight: 600,
              }}
            >
              {state.info.expired
                ? `Expired ${Math.abs(state.info.daysRemaining)} days ago`
                : `Expires in ${state.info.daysRemaining} days`}
            </dd>
          </dl>
        )}
    </div>
  )
}

export default TlsCertificateCard
