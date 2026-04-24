import { useEffect, useState } from "react"

import type { TokenRow } from "../types"

export interface TokenFormValues {
  name: string
  is_admin: boolean
  rpm_limit: number | null
  monthly_token_limit: number | null
  lifetime_token_limit: number | null
}

export function TokenFormDialog(props: {
  open: boolean
  initial?: TokenRow
  canEditAdminFlag: boolean
  onCancel: () => void
  onSubmit: (v: TokenFormValues) => void
}) {
  const [values, setValues] = useState<TokenFormValues>({
    name: "",
    is_admin: false,
    rpm_limit: null,
    monthly_token_limit: null,
    lifetime_token_limit: null,
  })

  useEffect(() => {
    if (!props.open) return
    if (props.initial) {
      setValues({
        name: props.initial.name,
        is_admin: props.initial.is_admin,
        rpm_limit: props.initial.rpm_limit,
        monthly_token_limit: props.initial.monthly_token_limit,
        lifetime_token_limit: props.initial.lifetime_token_limit,
      })
    } else {
      setValues({
        name: "",
        is_admin: false,
        rpm_limit: null,
        monthly_token_limit: null,
        lifetime_token_limit: null,
      })
    }
  }, [props.open, props.initial])

  if (!props.open) return null

  function nullableInt(s: string): number | null {
    if (s.trim() === "") return null
    const n = Number.parseInt(s, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>
          {props.initial ? "Edit token" : "New token"}
        </h3>
        <div className="field">
          <label>Name</label>
          <input
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
          />
        </div>
        {props.canEditAdminFlag && (
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={values.is_admin}
                onChange={(e) =>
                  setValues({ ...values, is_admin: e.target.checked })
                }
              />{" "}
              Admin
            </label>
          </div>
        )}
        <div className="field">
          <label>RPM limit (blank = unlimited)</label>
          <input
            value={values.rpm_limit ?? ""}
            onChange={(e) =>
              setValues({ ...values, rpm_limit: nullableInt(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>Monthly token limit</label>
          <input
            value={values.monthly_token_limit ?? ""}
            onChange={(e) =>
              setValues({
                ...values,
                monthly_token_limit: nullableInt(e.target.value),
              })
            }
          />
        </div>
        <div className="field">
          <label>Lifetime token limit</label>
          <input
            value={values.lifetime_token_limit ?? ""}
            onChange={(e) =>
              setValues({
                ...values,
                lifetime_token_limit: nullableInt(e.target.value),
              })
            }
          />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!values.name.trim()}
            onClick={() => props.onSubmit(values)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
