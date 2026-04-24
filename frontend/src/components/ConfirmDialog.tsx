import type { ReactNode } from "react"

export function ConfirmDialog(props: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!props.open) return null
  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{props.title}</h3>
        <div style={{ marginBottom: 16 }}>{props.body}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onCancel}>Cancel</button>
          <button
            className={props.destructive ? "danger" : "primary"}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  )
}
