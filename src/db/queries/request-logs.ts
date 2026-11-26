import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm"

import { startOfCurrentMonthMs } from "~/lib/usage-normalizer"

import { getDb } from "../client"
import { authTokens, requestLogs } from "../schema"

// Endpoints that are logged for audit but must NOT be counted toward
// per-token usage (no upstream Copilot quota is consumed by these calls).
const NON_BILLABLE_ENDPOINTS = ["/v1/messages/count_tokens"] as const

function nonBillableFilter() {
  return ne(requestLogs.endpoint, NON_BILLABLE_ENDPOINTS[0])
}

const billableExpr = sql<number>`coalesce(${requestLogs.billableTokens}, ${requestLogs.totalTokens}, 0)`

export interface NewRequestLog {
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model?: string | null
  promptTokens?: number | null
  cachedTokens?: number | null
  cacheCreationTokens?: number | null
  completionTokens?: number | null
  reasoningTokens?: number | null
  totalTokens?: number | null
  billableTokens?: number | null
  usageComplete?: boolean | number | null
  costNanoAiu?: number | null
  statusCode: number
  latencyMs?: number | null
}

function resolveBillableTokens(input: NewRequestLog): number | null {
  if (input.billableTokens !== undefined) return input.billableTokens
  if (input.endpoint === NON_BILLABLE_ENDPOINTS[0]) return 0
  return input.totalTokens ?? null
}

function resolveUsageComplete(input: NewRequestLog): number | null {
  if (typeof input.usageComplete === "boolean") {
    return input.usageComplete ? 1 : 0
  }
  return input.usageComplete ?? null
}

function buildRequestLogValues(input: NewRequestLog) {
  return {
    authTokenId: input.authTokenId,
    timestamp: input.timestamp,
    endpoint: input.endpoint,
    model: input.model ?? null,
    promptTokens: input.promptTokens ?? null,
    cachedTokens: input.cachedTokens ?? null,
    cacheCreationTokens: input.cacheCreationTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    reasoningTokens: input.reasoningTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    billableTokens: resolveBillableTokens(input),
    usageComplete: resolveUsageComplete(input),
    costNanoAiu: input.costNanoAiu ?? null,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs ?? null,
  }
}

export async function insertRequestLog(input: NewRequestLog): Promise<void> {
  const db = getDb()
  await db.insert(requestLogs).values(buildRequestLogValues(input))
}

export interface RecordRequestAndQuotaInput extends NewRequestLog {
  billable?: boolean
  monthStart?: number
}

/**
 * Atomically insert into `request_logs` and update `auth_tokens`
 * (`monthly_token_used` with lazy month rollover, `lifetime_token_used`,
 * and `last_used_at`) in a single SQLite transaction.
 */
export function recordRequestAndQuota(input: RecordRequestAndQuotaInput): void {
  const db = getDb()
  const values = buildRequestLogValues(input)
  const delta =
    input.billable === false ? 0 : Math.max(0, values.billableTokens ?? 0)
  const monthStart = input.monthStart ?? startOfCurrentMonthMs(values.timestamp)

  db.transaction((tx) => {
    tx.insert(requestLogs).values(values).run()
    if (values.authTokenId === null) return
    if (delta > 0) {
      tx.update(authTokens)
        .set({
          monthlyTokenUsed: sql`case when ${authTokens.monthlyWindowStart} < ${monthStart} then ${delta} else ${authTokens.monthlyTokenUsed} + ${delta} end`,
          monthlyWindowStart: sql`case when ${authTokens.monthlyWindowStart} < ${monthStart} then ${monthStart} else ${authTokens.monthlyWindowStart} end`,
          lifetimeTokenUsed: sql`${authTokens.lifetimeTokenUsed} + ${delta}`,
          lastUsedAt: values.timestamp,
        })
        .where(eq(authTokens.id, values.authTokenId))
        .run()
    } else {
      tx.update(authTokens)
        .set({ lastUsedAt: values.timestamp })
        .where(eq(authTokens.id, values.authTokenId))
        .run()
    }
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
    .select({ s: sql<number>`coalesce(sum(${billableExpr}), 0)` })
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
  cachedTokens: number | null
  cacheCreationTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
  billableTokens: number | null
  usageComplete: number | null
  costNanoAiu: number | null
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
          tokens: sql<number>`coalesce(sum(${billableExpr}), 0)`,
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
          tokens: sql<number>`coalesce(sum(${billableExpr}), 0)`,
        })
        .from(requestLogs)
        .where(and(...conditions))
        .groupBy(bucketExpr)
        .orderBy(bucketExpr)
  return rows.map((r) => ({
    bucketStart: r.bucketStart,
    requests: r.requests,
    tokens: r.tokens,
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
      t: sql<number>`coalesce(sum(${billableExpr}), 0)`,
    })
    .from(requestLogs)
    .where(and(gte(requestLogs.timestamp, since), nonBillableFilter()))
  return { requests: rows[0]?.r ?? 0, tokens: rows[0]?.t ?? 0 }
}

export interface UsageBreakdown {
  requests: number
  tokens: number
  promptTokens: number
  cachedTokens: number | null
  cacheCreationTokens: number | null
  completionTokens: number
  reasoningTokens: number | null
  totalTokens: number
  billableTokens: number
  cacheHitRate: number | null
  incompleteRequests: number
}

interface RawBreakdownRow {
  requests: number
  promptSum: number
  cachedSum: number
  cacheCreationCount: number
  cacheCreationSum: number
  completionSum: number
  reasoningCount: number
  reasoningSum: number
  totalSum: number
  billableSum: number
  completeCacheRows: number
  missingCacheRows: number
  completePromptBase: number
  incompleteRequests: number
}

function breakdownSelectFields() {
  return {
    requests: sql<number>`count(*)`,
    promptSum: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
    cachedSum: sql<number>`coalesce(sum(${requestLogs.cachedTokens}), 0)`,
    cacheCreationCount: sql<number>`count(${requestLogs.cacheCreationTokens})`,
    cacheCreationSum: sql<number>`coalesce(sum(${requestLogs.cacheCreationTokens}), 0)`,
    completionSum: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
    reasoningCount: sql<number>`count(${requestLogs.reasoningTokens})`,
    reasoningSum: sql<number>`coalesce(sum(${requestLogs.reasoningTokens}), 0)`,
    totalSum: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    billableSum: sql<number>`coalesce(sum(${billableExpr}), 0)`,
    completeCacheRows: sql<number>`coalesce(sum(case when ${requestLogs.cachedTokens} is not null and ${requestLogs.promptTokens} is not null then 1 else 0 end), 0)`,
    missingCacheRows: sql<number>`coalesce(sum(case when (${requestLogs.cachedTokens} is null or ${requestLogs.promptTokens} is null) and (${requestLogs.totalTokens} is not null or ${requestLogs.promptTokens} is not null) then 1 else 0 end), 0)`,
    completePromptBase: sql<number>`coalesce(sum(case when ${requestLogs.cachedTokens} is not null and ${requestLogs.promptTokens} is not null then ${requestLogs.promptTokens} else 0 end), 0)`,
    incompleteRequests: sql<number>`coalesce(sum(case when ${requestLogs.usageComplete} = 0 then 1 else 0 end), 0)`,
  }
}

export function emptyUsageBreakdown(): UsageBreakdown {
  return {
    requests: 0,
    tokens: 0,
    promptTokens: 0,
    cachedTokens: null,
    cacheCreationTokens: null,
    completionTokens: 0,
    reasoningTokens: null,
    totalTokens: 0,
    billableTokens: 0,
    cacheHitRate: null,
    incompleteRequests: 0,
  }
}

function mapBreakdownRow(row: RawBreakdownRow | undefined): UsageBreakdown {
  if (!row || row.requests === 0) return emptyUsageBreakdown()
  const {
    cachedSum,
    cacheCreationCount,
    reasoningCount,
    completeCacheRows,
    missingCacheRows,
    completePromptBase,
    billableSum,
  } = row
  const cacheComplete = completeCacheRows > 0 && missingCacheRows === 0
  const cacheHitRate =
    cacheComplete && completePromptBase > 0 ?
      Math.round((cachedSum / completePromptBase) * 1000) / 10
    : null
  return {
    requests: row.requests,
    tokens: billableSum,
    promptTokens: row.promptSum,
    cachedTokens: cacheComplete ? cachedSum : null,
    cacheCreationTokens: cacheCreationCount > 0 ? row.cacheCreationSum : null,
    completionTokens: row.completionSum,
    reasoningTokens: reasoningCount > 0 ? row.reasoningSum : null,
    totalTokens: row.totalSum,
    billableTokens: billableSum,
    cacheHitRate,
    incompleteRequests: row.incompleteRequests,
  }
}

export async function aggregateBreakdownInRange(opts: {
  from: number
  to: number
  tokenId?: number | "all"
}): Promise<UsageBreakdown> {
  const db = getDb()
  const conditions = [
    gte(requestLogs.timestamp, opts.from),
    lt(requestLogs.timestamp, opts.to),
    nonBillableFilter(),
  ]
  if (typeof opts.tokenId === "number") {
    conditions.push(eq(requestLogs.authTokenId, opts.tokenId))
  }
  const rows = await db
    .select(breakdownSelectFields())
    .from(requestLogs)
    .where(and(...conditions))
  return mapBreakdownRow(rows[0])
}

/**
 * Per-token aggregation in `[from, to)` (matching `timeseriesByBucket`),
 * grouped by `auth_token_id` in a single SQL query.
 */
export async function aggregateUsagePerTokenInRange(opts: {
  from: number
  to?: number
}): Promise<Map<number, UsageBreakdown>> {
  const db = getDb()
  const conditions = [
    gte(requestLogs.timestamp, opts.from),
    nonBillableFilter(),
  ]
  if (opts.to !== undefined) {
    conditions.push(lt(requestLogs.timestamp, opts.to))
  }
  const rows = await db
    .select({
      id: requestLogs.authTokenId,
      ...breakdownSelectFields(),
    })
    .from(requestLogs)
    .where(and(...conditions))
    .groupBy(requestLogs.authTokenId)
  const out = new Map<number, UsageBreakdown>()
  for (const row of rows) {
    if (row.id === null) continue
    out.set(row.id, mapBreakdownRow(row))
  }
  return out
}
