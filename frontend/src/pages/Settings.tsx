import { useEffect, useState } from "react"

import type { MeResponse } from "../types"

import { api } from "../api/client"
import { TlsCertificateCard } from "../components/TlsCertificateCard"

const TTL_KEY = "cpk_preferred_ttl"

export function Settings() {
  const [ttl, setTtl] = useState<number>(1)
  const [me, setMe] = useState<MeResponse | null>(null)

  useEffect(() => {
    const v = globalThis.localStorage.getItem(TTL_KEY)
    if (v) setTtl(Number.parseInt(v, 10))
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  function update(next: number) {
    setTtl(next)
    globalThis.localStorage.setItem(TTL_KEY, String(next))
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

      {me?.role === "super" && <TlsCertificateCard />}
    </div>
  )
}

export default Settings
