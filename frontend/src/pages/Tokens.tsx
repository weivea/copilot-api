import { useEffect, useState } from "react"

import type { TokenRow } from "../types"

import { api } from "../api/client"
import { ConfirmDialog } from "../components/ConfirmDialog"
import {
  TokenFormDialog,
  type TokenFormValues,
} from "../components/TokenFormDialog"
import { useAuth } from "../contexts/AuthContext"

function fmtDate(ms: number | null): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString()
}

export function Tokens() {
  const { me } = useAuth()
  const [rows, setRows] = useState<Array<TokenRow>>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<TokenRow | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    onConfirm: () => void
    destructive?: boolean
  } | null>(null)
  type RevealState =
    | { kind: "created"; token: string; prefix: string; name: string }
    | { kind: "rotated"; token: string; prefix: string; name: string }

  const [reveal, setReveal] = useState<RevealState | null>(null)

  async function load() {
    try {
      setRows(await api.listTokens())
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  if (!me) return null
  const isSuper = me.role === "super"

  async function onCreate(values: TokenFormValues) {
    try {
      const created = await api.createToken({
        name: values.name,
        is_admin: values.is_admin,
        rpm_limit: values.rpm_limit,
        monthly_token_limit: values.monthly_token_limit,
        lifetime_token_limit: values.lifetime_token_limit,
      })
      setCreating(false)
      setReveal({
        kind: "created",
        token: created.token,
        prefix: created.token_prefix,
        name: created.name,
      })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onEdit(values: TokenFormValues) {
    if (!editing) return
    try {
      await api.patchToken(editing.id, {
        name: values.name,
        rpm_limit: values.rpm_limit,
        monthly_token_limit: values.monthly_token_limit,
        lifetime_token_limit: values.lifetime_token_limit,
        ...(isSuper ? { is_admin: values.is_admin } : {}),
      } as Partial<TokenRow>)
      setEditing(undefined)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onRotate(r: TokenRow) {
    try {
      const result = await api.rotateToken(r.id)
      setReveal({
        kind: "rotated",
        token: result.token,
        prefix: result.token_prefix,
        name: r.name,
      })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function ask(
    title: string,
    body: string,
    fn: () => Promise<void>,
    destructive = false,
  ) {
    setConfirm({
      title,
      body,
      destructive,
      onConfirm: async () => {
        setConfirm(null)
        try {
          await fn()
          await load()
        } catch (e) {
          setError((e as Error).message)
        }
      },
    })
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ flex: 1, margin: 0 }}>Tokens</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + New token
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Role</th>
            <th>RPM</th>
            <th>Monthly limit</th>
            <th>Lifetime used / limit</th>
            <th>Last used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSuperRow = r.is_super_admin === true
            const canEdit = !isSuperRow && (isSuper || !r.is_admin)
            return (
              <tr key={r.id}>
                <td>
                  {r.name}
                  {isSuperRow && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "var(--bg)",
                        border: "1px solid var(--border)",
                      }}
                      title="System-managed super admin row"
                    >
                      system
                    </span>
                  )}
                  {r.is_disabled && <span className="error"> (disabled)</span>}
                </td>
                <td>
                  <code>{r.token_prefix}</code>
                </td>
                <td>
                  {isSuperRow ?
                    "super"
                  : r.is_admin ?
                    "admin"
                  : "user"}
                </td>
                <td>{r.rpm_limit ?? "—"}</td>
                <td>{r.monthly_token_limit ?? "—"}</td>
                <td>
                  {r.lifetime_token_used.toLocaleString()} /{" "}
                  {r.lifetime_token_limit?.toLocaleString() ?? "—"}
                </td>
                <td>{fmtDate(r.last_used_at)}</td>
                <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {canEdit && (
                    <button onClick={() => setEditing(r)}>Edit</button>
                  )}
                  {canEdit && (
                    <button
                      onClick={() =>
                        ask(
                          "Rotate token?",
                          `Generate a new token for "${r.name}"? The current token will be revoked immediately and any active dashboard sessions for it will be terminated.`,
                          () => onRotate(r),
                          true,
                        )
                      }
                    >
                      Rotate
                    </button>
                  )}
                  {canEdit && (
                    <button
                      onClick={() =>
                        ask(
                          "Reset monthly?",
                          `Reset monthly usage counter for "${r.name}"?`,
                          () => api.resetMonthly(r.id),
                        )
                      }
                    >
                      Reset monthly
                    </button>
                  )}
                  {isSuper && !isSuperRow && (
                    <button
                      onClick={() =>
                        ask(
                          "Reset lifetime?",
                          `Zero out lifetime usage for "${r.name}"?`,
                          () => api.resetLifetime(r.id),
                          true,
                        )
                      }
                    >
                      Reset lifetime
                    </button>
                  )}
                  {canEdit && (
                    <button
                      onClick={() =>
                        ask(
                          r.is_disabled ? "Enable?" : "Disable?",
                          `${r.is_disabled ? "Enable" : "Disable"} "${r.name}"?`,
                          () =>
                            api
                              .patchToken(r.id, {
                                is_disabled: !r.is_disabled,
                              } as Partial<TokenRow>)
                              .then(() => undefined),
                        )
                      }
                    >
                      {r.is_disabled ? "Enable" : "Disable"}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      className="danger"
                      onClick={() =>
                        ask(
                          "Delete token?",
                          `Permanently delete "${r.name}"? Active sessions for this token will be terminated.`,
                          () => api.deleteToken(r.id),
                          true,
                        )
                      }
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <TokenFormDialog
        open={creating}
        canEditAdminFlag={isSuper}
        onCancel={() => setCreating(false)}
        onSubmit={(v) => void onCreate(v)}
      />
      <TokenFormDialog
        open={editing !== undefined}
        initial={editing}
        canEditAdminFlag={isSuper}
        onCancel={() => setEditing(undefined)}
        onSubmit={(v) => void onEdit(v)}
      />
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          body={confirm.body}
          destructive={confirm.destructive}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}

      {reveal && (
        <div className="dialog-backdrop" onClick={() => setReveal(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>
              {reveal.kind === "created" ? "Token created" : "Token rotated"}
            </h3>
            <p>
              {reveal.kind === "created" ?
                <>
                  Copy the token now.{" "}
                  <strong>It will never be shown again.</strong>
                </>
              : <>
                  This is the new token for &quot;{reveal.name}&quot;. Copy it
                  now. It will never be shown again. The previous token has been
                  revoked.
                </>
              }
            </p>
            <p style={{ marginTop: 0, color: "var(--muted)", fontSize: 13 }}>
              Prefix: <code>{reveal.prefix}</code>
            </p>
            <pre
              style={{
                background: "var(--bg)",
                padding: 12,
                borderRadius: 6,
                wordBreak: "break-all",
                whiteSpace: "pre-wrap",
              }}
            >
              {reveal.token}
            </pre>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                onClick={() => void navigator.clipboard.writeText(reveal.token)}
              >
                Copy
              </button>
              <button className="primary" onClick={() => setReveal(null)}>
                I&apos;ve saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Tokens
