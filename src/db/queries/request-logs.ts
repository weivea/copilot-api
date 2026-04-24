import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm"

import { getDb } from "../client"
import { requestLogs } from "../schema"

// Endpoints that are logged for audit but must NOT be counted toward
// per-token usage (no upstream Copilot quota is consumed by these calls).
const NON_BILLABLE_ENDPOINTS = ["/v1/messages/count_tokens"] as const

function nonBillableFilter() {
  return ne(requestLogs.endpoint, NON_BILLABLE_ENDPOINTS[0])
}

export interface NewRequestLog {
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  statusCode: number
  latencyMs?: number | null
}

export async function insertRequestLog(input: NewRequestLog): Promise<void> {
  const db = getDb()
  await db.insert(requestLogs).values({
    authTokenId: input.authTokenId,
    timestamp: input.timestamp,
    endpoint: input.endpoint,
    model: input.model ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs ?? null,
  })
}

export async function countRequestsSince(
  tokenId: number,
  since: number,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.authTokenId, tokenId),
        gte(requestLogs.timestamp, since),
        nonBillableFilter(),
      ),
    )
  return rows[0]?.c ?? 0
}

export async function sumTokensSince(
  tokenId: number,
  since: number,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ s: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)` })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.authTokenId, tokenId),
        gte(requestLogs.timestamp, since),
        nonBillableFilter(),
      ),
    )
  return rows[0]?.s ?? 0
}

export interface RecentLog {
  id: number
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  statusCode: number
  latencyMs: number | null
}

export async function recentLogs(opts: {
  tokenId?: number
  limit: number
}): Promise<Array<RecentLog>> {
  const db = getDb()
  const q = db
    .select()
    .from(requestLogs)
    .orderBy(desc(requestLogs.timestamp))
    .limit(opts.limit)
  const filtered =
    opts.tokenId !== undefined ?
      q.where(eq(requestLogs.authTokenId, opts.tokenId))
    : q
  return (await filtered) as Array<RecentLog>
}

export type Bucket = "hour" | "day" | "week" | "month"

const BUCKET_MS: Record<Bucket, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000, // approximate; UI labels months by start ts
}

export interface TimeseriesRow {
  bucketStart: number
  requests: number
  tokens: number
  authTokenId: number | null
}

export async function timeseriesByBucket(opts: {
  tokenId?: number | "all"
  from: number
  to: number
  bucket: Bucket
}): Promise<Array<TimeseriesRow>> {
  const db = getDb()
  const size = BUCKET_MS[opts.bucket]
  const bucketExpr = sql<number>`(${requestLogs.timestamp} / ${size}) * ${size}`
  const conditions = [
    gte(requestLogs.timestamp, opts.from),
    lt(requestLogs.timestamp, opts.to),
    nonBillableFilter(),
  ]
  if (typeof opts.tokenId === "number") {
    conditions.push(eq(requestLogs.authTokenId, opts.tokenId))
  }
  const splitByToken = opts.tokenId === "all"
  const rows =
    splitByToken ?
      await db
        .select({
          bucketStart: bucketExpr,
          requests: sql<number>`count(*)`,
          tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
          authTokenId: requestLogs.authTokenId,
        })
        .from(requestLogs)
        .where(and(...conditions))
        .groupBy(bucketExpr, requestLogs.authTokenId)
        .orderBy(bucketExpr)
    : await db
        .select({
          bucketStart: bucketExpr,
          requests: sql<number>`count(*)`,
          tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
        })
        .from(requestLogs)
        .where(and(...conditions))
        .groupBy(bucketExpr)
        .orderBy(bucketExpr)
  return rows.map((r) => ({
    bucketStart: Number(r.bucketStart),
    requests: Number(r.requests),
    tokens: Number(r.tokens),
    authTokenId: "authTokenId" in r ? (r.authTokenId as number | null) : null,
  }))
}

export async function pruneOldLogs(cutoff: number): Promise<void> {
  const db = getDb()
  await db.delete(requestLogs).where(lt(requestLogs.timestamp, cutoff))
}

// Time-throttled prune: at most one execution per PRUNE_INTERVAL_MS in this
// process. Replaces the previous random-sampling approach which still ran
// (Math.random() < 0.01) on the hot path of every request.
const PRUNE_INTERVAL_MS = 5 * 60_000
let lastPruneAt = 0

export async function maybePruneOldLogs(retentionMs: number): Promise<void> {
  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  await pruneOldLogs(now - retentionMs)
}

/**
 * Aggregate billable usage across ALL auth tokens since a given timestamp,
 * in a single SQL query (replaces the N+1 pattern in admin/usage summary).
 */
export async function aggregateUsageSince(since: number): Promise<{
  requests: number
  tokens: number
}> {
  const db = getDb()
  const rows = await db
    .select({
      r: sql<number>`count(*)`,
      t: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    })
    .from(requestLogs)
    .where(and(gte(requestLogs.timestamp, since), nonBillableFilter()))
  return { requests: rows[0]?.r ?? 0, tokens: rows[0]?.t ?? 0 }
}

/**
 * Per-token aggregation in a single SQL query, grouped by auth_token_id.
 * Returns a Map keyed by auth_token_id (null entries are dropped).
 */
export async function aggregateUsagePerTokenSince(
  since: number,
): Promise<Map<number, { requests: number; tokens: number }>> {
  const db = getDb()
  const rows = await db
    .select({
      id: requestLogs.authTokenId,
      r: sql<number>`count(*)`,
      t: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    })
    .from(requestLogs)
    .where(and(gte(requestLogs.timestamp, since), nonBillableFilter()))
    .groupBy(requestLogs.authTokenId)
  const out = new Map<number, { requests: number; tokens: number }>()
  for (const row of rows) {
    if (row.id === null) continue
    out.set(row.id, {
      requests: row.r,
      tokens: row.t,
    })
  }
  return out
}
