const PRESETS: Array<{ label: string; days: number | "today" }> = [
  { label: "Today", days: "today" },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
]

export interface Range {
  from: number
  to: number
  presetLabel: string
}

export function rangeFromPreset(p: { days: number | "today" }): Range {
  const now = Date.now()
  if (p.days === "today") {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return { from: d.getTime(), to: now, presetLabel: "Today" }
  }
  return {
    from: now - p.days * 86_400_000,
    to: now,
    presetLabel: `${p.days} days`,
  }
}

export function TimeRangePicker(props: {
  value: Range
  onChange: (r: Range) => void
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {PRESETS.map((p) => (
        <button
          key={p.label}
          className={p.label === props.value.presetLabel ? "primary" : ""}
          onClick={() => props.onChange(rangeFromPreset(p))}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
