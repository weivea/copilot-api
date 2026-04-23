import type { Context, MiddlewareHandler } from "hono"

import { deleteCookie, getCookie, setCookie } from "hono/cookie"

import { getAuthTokenById } from "~/db/queries/auth-tokens"
import {
  createSession,
  deleteSession,
  getSessionById,
} from "~/db/queries/sessions"

export const SESSION_COOKIE = "cpk_session"

export interface ResolvedSession {
  role: "super" | "admin" | "user"
  authTokenId: number | null
  name: string
}

export async function startSessionForSuperAdmin(
  c: Context,
  ttlMs: number,
): Promise<void> {
  const id = await createSession({
    authTokenId: null,
    isSuperAdmin: true,
    ttlMs,
  })
  writeSessionCookie(c, id, ttlMs)
}

export async function startSessionForToken(
  c: Context,
  authTokenId: number,
  ttlMs: number,
): Promise<void> {
  const id = await createSession({
    authTokenId,
    isSuperAdmin: false,
    ttlMs,
  })
  writeSessionCookie(c, id, ttlMs)
}

function writeSessionCookie(c: Context, id: string, ttlMs: number): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: c.req.url.startsWith("https://"),
    maxAge: Math.floor(ttlMs / 1000),
  })
}

export async function endCurrentSession(c: Context): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE)
  if (id) await deleteSession(id)
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
}

export async function resolveSession(
  c: Context,
): Promise<ResolvedSession | null> {
  const id = getCookie(c, SESSION_COOKIE)
  if (!id) return null
  const row = await getSessionById(id)
  if (!row || row.expiresAt < Date.now()) return null
  if (row.isSuperAdmin === 1) {
    return { role: "super", authTokenId: null, name: "super-admin" }
  }
  if (row.authTokenId === null) return null
  const tok = await getAuthTokenById(row.authTokenId)
  if (!tok || tok.isDisabled === 1) return null
  return {
    role: tok.isAdmin === 1 ? "admin" : "user",
    authTokenId: tok.id,
    name: tok.name,
  }
}

export function sessionMiddleware(
  options: { requireRole?: "admin" | "super" } = {},
): MiddlewareHandler {
  return async (c, next) => {
    const session = await resolveSession(c)
    if (!session) {
      return c.json(
        { error: { type: "auth_error", message: "Not authenticated" } },
        401,
      )
    }
    if (options.requireRole === "super" && session.role !== "super") {
      return c.json(
        {
          error: { type: "permission_denied", message: "Super admin required" },
        },
        403,
      )
    }
    if (
      options.requireRole === "admin"
      && session.role !== "admin"
      && session.role !== "super"
    ) {
      return c.json(
        { error: { type: "permission_denied", message: "Admin required" } },
        403,
      )
    }
    c.set("sessionRole", session.role)
    c.set("sessionTokenId", session.authTokenId)
    await next()
  }
}
