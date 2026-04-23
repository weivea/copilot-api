import { Hono } from "hono"
import { z } from "zod"

import {
  getAuthTokenById,
  listAuthTokens,
} from "~/db/queries/auth-tokens"
import {
  countRequestsSince,
  recentLogs,
  sumTokensSince,
  timeseriesByBucket,
  type Bucket,
} from "~/db/queries/request-logs"
import { latestUsageReset } from "~/db/queries/usage-resets"
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

function resolveTokenId(
  c: any,
  raw: string | undefined,
): { kind: "all" | "id"; id?: number } | { error: Response } {
  const role = c.get("sessionRole")
  const sessionTokenId = c.get("sessionTokenId") as number | null | undefined
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
  if (
    role === "user"
    && (sessionTokenId === null || sessionTokenId !== id)
  ) {
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
    // Aggregate across all DB tokens
    const rows = await listAuthTokens()
    const todayStart = startOfTodayMs()
    let reqToday = 0
    let tokToday = 0
    let monthlyUsed = 0
    for (const r of rows) {
      reqToday += await countRequestsSince(r.id, todayStart)
      tokToday += await sumTokensSince(r.id, todayStart)
      const reset = await latestUsageReset(r.id, "monthly")
      const since = Math.max(startOfMonthMs(), reset)
      monthlyUsed += await sumTokensSince(r.id, since)
    }
    return c.json({
      requests_today: reqToday,
      tokens_today: tokToday,
      monthly_used: monthlyUsed,
      monthly_limit: null,
      lifetime_used: rows.reduce((s, r) => s + r.lifetimeTokenUsed, 0),
      lifetime_limit: null,
    })
  }
  const id = resolved.id!
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
  const to = Number.parseInt(
    c.req.query("to") ?? String(Date.now() + 1),
    10,
  )
  const rows = await listAuthTokens()
  const out = []
  for (const r of rows) {
    const requests = await countRequestsSince(r.id, from)
    const tokens = await sumTokensSince(r.id, from)
    out.push({
      id: r.id,
      name: r.name,
      requests,
      tokens,
      monthly_pct:
        r.monthlyTokenLimit && r.monthlyTokenLimit > 0
          ? Math.min(100, Math.round((tokens / r.monthlyTokenLimit) * 100))
          : null,
      last_used_at: r.lastUsedAt,
    })
    void to
  }
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
