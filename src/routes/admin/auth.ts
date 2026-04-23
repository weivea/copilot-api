import type { Context } from "hono"

import { Hono } from "hono"
import crypto from "node:crypto"
import { z } from "zod"

import { findAuthTokenByHash } from "~/db/queries/auth-tokens"
import { hashToken } from "~/lib/auth-token-utils"
import {
  endCurrentSession,
  resolveSession,
  startSessionForSuperAdmin,
  startSessionForToken,
} from "~/lib/session"
import { state } from "~/lib/state"

const LoginSchema = z.object({
  key: z.string().min(1),
  ttl_days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
})

function dashboardGate(c: Context) {
  return c.json(
    { error: { type: "dashboard_disabled", message: "Dashboard is disabled" } },
    503,
  )
}

export const adminAuthRoutes = new Hono()

adminAuthRoutes.post("/login", async (c) => {
  if (!state.dashboardEnabled || !state.authEnabled) return dashboardGate(c)
  const parsed = LoginSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "Invalid login body" } },
      400,
    )
  }
  const { key, ttl_days } = parsed.data
  const ttlMs = ttl_days * 86_400_000
  const presented = hashToken(key)
  // Super admin first
  if (state.superAdminTokenHash) {
    const matchSuper = (() => {
      try {
        return crypto.timingSafeEqual(
          Buffer.from(presented),
          Buffer.from(state.superAdminTokenHash),
        )
      } catch {
        return false
      }
    })()
    if (matchSuper) {
      await startSessionForSuperAdmin(c, ttlMs)
      return c.json({ role: "super", name: "super-admin" })
    }
  }
  const row = await findAuthTokenByHash(presented)
  if (!row || row.isDisabled === 1) {
    return c.json(
      { error: { type: "auth_error", message: "Invalid auth token." } },
      401,
    )
  }
  await startSessionForToken(c, row.id, ttlMs)
  return c.json({ role: row.isAdmin === 1 ? "admin" : "user", name: row.name })
})

adminAuthRoutes.post("/logout", async (c) => {
  await endCurrentSession(c)
  return c.json({ ok: true })
})

adminAuthRoutes.get("/me", async (c) => {
  const session = await resolveSession(c)
  if (!session) {
    return c.json(
      { error: { type: "auth_error", message: "Not authenticated" } },
      401,
    )
  }
  return c.json(session)
})
