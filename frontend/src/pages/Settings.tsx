import { useEffect, useState } from "react"

const TTL_KEY = "cpk_preferred_ttl"

export function Settings() {
  const [ttl, setTtl] = useState<number>(1)

  useEffect(() => {
    const v = window.localStorage.getItem(TTL_KEY)
    if (v) setTtl(Number.parseInt(v, 10))
  }, [])

  function update(next: number) {
    setTtl(next)
    window.localStorage.setItem(TTL_KEY, String(next))
  }

  return (
    <div>
      <h2>Settings</h2>
      <div className="card" style={{ maxWidth: 420 }}>
        <div className="field">
          <label>Default session duration</label>
          <select
            value={ttl}
            onChange={(e) => update(Number.parseInt(e.target.value, 10))}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
        <p className="label">
          Applied at next sign-in. Stored locally in this browser only.
        </p>
      </div>
    </div>
  )
}
