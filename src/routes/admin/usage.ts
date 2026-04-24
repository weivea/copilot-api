import { type Context, Hono } from "hono"
import { z } from "zod"

import { getAuthTokenById, listAuthTokens } from "~/db/queries/auth-tokens"
import {
  aggregateUsagePerTokenSince,
  aggregateUsageSince,
  countRequestsSince,
  recentLogs,
  sumTokensSince,
  timeseriesByBucket,
  type Bucket,
} from "~/db/queries/request-logs"
import {
  latestUsageReset,
  latestUsageResetsByKind,
} from "~/db/queries/usage-resets"
import { sessionMiddleware } from "~/lib/session"

export const adminUsageRoutes = new Hono()

adminUsageRoutes.use("*", sessionMiddleware())

function startOfTodayMs(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfMonthMs(): number {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

type ResolveResult =
  | { kind: "all" }
  | { kind: "id"; id: number }
  | { error: Response }

function resolveTokenId(c: Context, raw: string | undefined): ResolveResult {
  const role = c.get("sessionRole")
  const sessionTokenId = c.get("sessionTokenId")
  if (raw === "all") {
    if (role !== "admin" && role !== "super") {
      return {
        error: c.json(
          { error: { type: "permission_denied", message: "Admin required" } },
          403,
        ),
      }
    }
    return { kind: "all" }
  }
  if (raw === undefined || raw === "me") {
    if (sessionTokenId === null || sessionTokenId === undefined) {
      // Super admin asking for "me" - default to all
      return { kind: "all" }
    }
    return { kind: "id", id: sessionTokenId }
  }
  const id = Number.parseInt(raw, 10)
  if (!Number.isFinite(id)) {
    return {
      error: c.json(
        { error: { type: "bad_request", message: "bad token_id" } },
        400,
      ),
    }
  }
  if (role === "user" && (sessionTokenId === null || sessionTokenId !== id)) {
    return {
      error: c.json(
        {
          error: {
            type: "permission_denied",
            message: "Cannot view another token",
          },
        },
        403,
      ),
    }
  }
  return { kind: "id", id }
}

adminUsageRoutes.get("/summary", async (c) => {
  const resolved = resolveTokenId(c, c.req.query("token_id"))
  if ("error" in resolved) return resolved.error
  if (resolved.kind === "all") {
    // Aggregate across all DB tokens — single SQL queries instead of N+1.
    const todayStart = startOfTodayMs()
    const monthStart = startOfMonthMs()
    const [today, monthly, resets, rows] = await Promise.all([
      aggregateUsageSince(todayStart),
      aggregateUsagePerTokenSince(monthStart),
      latestUsageResetsByKind("monthly"),
      listAuthTokens(),
    ])

    // Apply per-token monthly reset (anyone reset after start-of-month
    // restarts their monthly counter; we conservatively re-query those).
    let monthlyUsed = 0
    for (const r of rows) {
      const reset = resets.get(r.id) ?? 0
      monthlyUsed +=
        reset > monthStart ?
          // Token was reset mid-month; recompute its slice precisely.
          await sumTokensSince(r.id, reset)
        : (monthly.get(r.id)?.tokens ?? 0)
    }

    return c.json({
      requests_today: today.requests,
      tokens_today: today.tokens,
      monthly_used: monthlyUsed,
      monthly_limit: null,
      lifetime_used: rows.reduce((s, r) => s + r.lifetimeTokenUsed, 0),
      lifetime_limit: null,
    })
  }
  const id = resolved.id
  const tok = await getAuthTokenById(id)
  if (!tok) {
    return c.json(
      { error: { type: "not_found", message: "token not found" } },
      404,
    )
  }
  const todayStart = startOfTodayMs()
  const reset = await latestUsageReset(id, "monthly")
  const since = Math.max(startOfMonthMs(), reset)
  return c.json({
    requests_today: await countRequestsSince(id, todayStart),
    tokens_today: await sumTokensSince(id, todayStart),
    monthly_used: await sumTokensSince(id, since),
    monthly_limit: tok.monthlyTokenLimit,
    lifetime_used: tok.lifetimeTokenUsed,
    lifetime_limit: tok.lifetimeTokenLimit,
  })
})

const TimeseriesSchema = z.object({
  from: z.coerce.number(),
  to: z.coerce.number(),
  bucket: z.enum(["hour", "day", "week", "month"]),
})

adminUsageRoutes.get("/timeseries", async (c) => {
  const resolved = resolveTokenId(c, c.req.query("token_id"))
  if ("error" in resolved) return resolved.error
  const parsed = TimeseriesSchema.safeParse({
    from: c.req.query("from"),
    to: c.req.query("to"),
    bucket: c.req.query("bucket"),
  })
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "from/to/bucket required" } },
      400,
    )
  }
  const rows = await timeseriesByBucket({
    tokenId: resolved.kind === "all" ? "all" : resolved.id,
    from: parsed.data.from,
    to: parsed.data.to,
    bucket: parsed.data.bucket as Bucket,
  })
  return c.json(rows)
})

adminUsageRoutes.get("/per-token", async (c) => {
  const role = c.get("sessionRole")
  if (role !== "admin" && role !== "super") {
    return c.json(
      { error: { type: "permission_denied", message: "Admin required" } },
      403,
    )
  }
  const from = Number.parseInt(c.req.query("from") ?? "0", 10)
  const [rows, agg] = await Promise.all([
    listAuthTokens(),
    aggregateUsagePerTokenSince(from),
  ])
  const out = rows.map((r) => {
    const a = agg.get(r.id) ?? { requests: 0, tokens: 0 }
    return {
      id: r.id,
      name: r.name,
      requests: a.requests,
      tokens: a.tokens,
      monthly_pct:
        r.monthlyTokenLimit && r.monthlyTokenLimit > 0 ?
          Math.min(100, Math.round((a.tokens / r.monthlyTokenLimit) * 100))
        : null,
      last_used_at: r.lastUsedAt,
    }
  })
  return c.json(out)
})

adminUsageRoutes.get("/recent", async (c) => {
  const resolved = resolveTokenId(c, c.req.query("token_id"))
  if ("error" in resolved) return resolved.error
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(c.req.query("limit") ?? "50", 10)),
  )
  const rows = await recentLogs({
    tokenId: resolved.kind === "id" ? resolved.id : undefined,
    limit,
  })
  return c.json(rows)
})
