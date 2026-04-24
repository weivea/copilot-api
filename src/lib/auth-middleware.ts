import type { MiddlewareHandler } from "hono"

import crypto from "node:crypto"

import { findAuthTokenByHash } from "~/db/queries/auth-tokens"
import { countRequestsSince, sumTokensSince } from "~/db/queries/request-logs"
import { latestUsageReset } from "~/db/queries/usage-resets"
import { hashToken } from "~/lib/auth-token-utils"
import { state } from "~/lib/state"

function extractToken(c: {
  req: { header: (name: string) => string | undefined }
}): string | undefined {
  const authHeader = c.req.header("authorization")
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7)
  return c.req.header("x-api-key")
}

function constantTimeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

function jsonError(
  type: string,
  message: string,
  extras: Record<string, unknown> = {},
) {
  return { error: { type, message, ...extras } }
}

function startOfCurrentMonthMs(): number {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const PROTECTED_EXACT = new Set(["/token"])
const PROTECTED_PREFIXES = [
  "/chat/completions",
  "/models",
  "/embeddings",
  "/v1/",
]

function isProtectedPath(path: string): boolean {
  if (PROTECTED_EXACT.has(path)) return true
  return PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`),
  )
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!state.authEnabled) return next()

    // Health check stays open
    if (c.req.path === "/healthz") return next()

    // Only enforce on real API endpoints; let SPA assets/routes fall through
    if (!isProtectedPath(c.req.path)) return next()

    const presented = extractToken(c)
    if (!presented) {
      return c.json(
        jsonError(
          "auth_error",
          "Missing auth token. Set Authorization header or x-api-key header.",
        ),
        401,
      )
    }

    // Super admin first
    if (
      state.superAdminTokenHash !== undefined
      && constantTimeEqual(hashToken(presented), state.superAdminTokenHash)
    ) {
      if (state.superAdminTokenId !== undefined) {
        c.set("authTokenId", state.superAdminTokenId)
      }
      return next()
    }

    // DB token
    const row = await findAuthTokenByHash(hashToken(presented))
    if (!row || row.isDisabled === 1) {
      return c.json(jsonError("auth_error", "Invalid auth token."), 401)
    }

    // RPM
    if (row.rpmLimit !== null && row.rpmLimit > 0) {
      const since = Date.now() - 60_000
      const count = await countRequestsSince(row.id, since)
      if (count >= row.rpmLimit) {
        return c.json(
          jsonError("rate_limit_exceeded", "Per-minute request limit hit.", {
            retry_after_ms: 60_000,
          }),
          429,
        )
      }
    }

    // Monthly
    if (row.monthlyTokenLimit !== null && row.monthlyTokenLimit > 0) {
      const lastReset = await latestUsageReset(row.id, "monthly")
      const since = Math.max(startOfCurrentMonthMs(), lastReset)
      const used = await sumTokensSince(row.id, since)
      if (used >= row.monthlyTokenLimit) {
        return c.json(
          jsonError("monthly_quota_exceeded", "Monthly token quota exceeded."),
          429,
        )
      }
    }

    // Lifetime
    if (
      row.lifetimeTokenLimit !== null
      && row.lifetimeTokenLimit > 0
      && row.lifetimeTokenUsed >= row.lifetimeTokenLimit
    ) {
      return c.json(
        jsonError("account_quota_exhausted", "Lifetime token quota exhausted."),
        403,
      )
    }

    c.set("authTokenId", row.id)
    return next()
  }
}
