import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"

import { api } from "../api/client"
import type { MeResponse } from "../types"

interface AuthState {
  me: MeResponse | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const m = await api.me()
      setMe(m)
    } catch {
      setMe(null)
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    try {
      await api.logout()
    } finally {
      setMe(null)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Ctx.Provider value={{ me, loading, refresh, logout }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error("AuthProvider missing")
  return v
}
