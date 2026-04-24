import { and, desc, eq, gte, lt, sql } from "drizzle-orm"

import { getDb } from "../client"
import { requestLogs } from "../schema"

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

export async function maybePruneOldLogs(retentionMs: number): Promise<void> {
  if (Math.random() > 0.01) return
  await pruneOldLogs(Date.now() - retentionMs)
}
