import { type Context, Hono } from "hono"
import { z } from "zod"

import { getAuthTokenById, listAuthTokens } from "~/db/queries/auth-tokens"
import {
  aggregateBreakdownInRange,
  aggregateUsagePerTokenInRange,
  aggregateUsageSince,
  type Bucket,
  countRequestsSince,
  emptyUsageBreakdown,
  recentLogs,
  sumTokensSince,
  timeseriesByBucket,
  type UsageBreakdown,
} from "~/db/queries/request-logs"
import { sessionMiddleware } from "~/lib/session"
import {
  getEffectiveMonthlyUsed,
  startOfCurrentMonthMs,
} from "~/lib/usage-normalizer"

export const adminUsageRoutes = new Hono()

adminUsageRoutes.use("*", sessionMiddleware())

function startOfTodayMs(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function parseOptionalRange(c: Context): { from: number; to: number } | null {
  const rawFrom = c.req.query("from")
  const rawTo = c.req.query("to")
  if (rawFrom === undefined || rawTo === undefined) return null
  const from = Number(rawFrom)
  const to = Number(rawTo)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return { from, to }
}

function serializeBreakdown(b: UsageBreakdown) {
  return {
    requests: b.requests,
    tokens: b.billableTokens,
    prompt_tokens: b.promptTokens,
    cached_tokens: b.cachedTokens,
    cache_creation_tokens: b.cacheCreationTokens,
    completion_tokens: b.completionTokens,
    reasoning_tokens: b.reasoningTokens,
    total_tokens: b.totalTokens,
    billable_tokens: b.billableTokens,
    cache_hit_rate: b.cacheHitRate,
    incomplete_requests: b.incompleteRequests,
  }
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
  const todayStart = startOfTodayMs()
  const monthStart = startOfCurrentMonthMs()
  const range = parseOptionalRange(c)

  if (resolved.kind === "all") {
    const [today, rows, breakdown] = await Promise.all([
      aggregateUsageSince(todayStart),
      listAuthTokens(),
      range ?
        aggregateBreakdownInRange({
          from: range.from,
          to: range.to,
          tokenId: "all",
        })
      : Promise.resolve(null),
    ])

    const monthlyUsed = rows.reduce(
      (sum, r) => sum + getEffectiveMonthlyUsed(r, monthStart),
      0,
    )

    return c.json({
      requests_today: today.requests,
      tokens_today: today.tokens,
      monthly_used: monthlyUsed,
      monthly_limit: null,
      lifetime_used: rows.reduce((s, r) => s + r.lifetimeTokenUsed, 0),
      lifetime_limit: null,
      range_breakdown: breakdown ? serializeBreakdown(breakdown) : null,
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
  const [requestsToday, tokensToday, breakdown] = await Promise.all([
    countRequestsSince(id, todayStart),
    sumTokensSince(id, todayStart),
    range ?
      aggregateBreakdownInRange({
        from: range.from,
        to: range.to,
        tokenId: id,
      })
    : Promise.resolve(null),
  ])
  return c.json({
    requests_today: requestsToday,
    tokens_today: tokensToday,
    monthly_used: getEffectiveMonthlyUsed(tok, monthStart),
    monthly_limit: tok.monthlyTokenLimit,
    lifetime_used: tok.lifetimeTokenUsed,
    lifetime_limit: tok.lifetimeTokenLimit,
    range_breakdown: breakdown ? serializeBreakdown(breakdown) : null,
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
  const rawFrom = Number.parseInt(c.req.query("from") ?? "0", 10)
  const from = Number.isFinite(rawFrom) ? rawFrom : 0
  const rawTo = c.req.query("to")
  const parsedTo = rawTo === undefined ? undefined : Number.parseInt(rawTo, 10)
  const to =
    parsedTo !== undefined && Number.isFinite(parsedTo) ? parsedTo : undefined

  const monthStart = startOfCurrentMonthMs()
  const [rows, agg] = await Promise.all([
    listAuthTokens(),
    aggregateUsagePerTokenInRange({ from, to }),
  ])
  const out = rows.map((r) => {
    const a = agg.get(r.id) ?? emptyUsageBreakdown()
    const monthlyUsed = getEffectiveMonthlyUsed(r, monthStart)
    return {
      id: r.id,
      name: r.name,
      ...serializeBreakdown(a),
      monthly_used: monthlyUsed,
      monthly_limit: r.monthlyTokenLimit,
      monthly_pct:
        r.monthlyTokenLimit && r.monthlyTokenLimit > 0 ?
          Math.min(100, Math.round((monthlyUsed / r.monthlyTokenLimit) * 100))
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
