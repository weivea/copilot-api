import { and, desc, eq, sql } from "drizzle-orm"

import { getDb } from "../client"
import { usageResets } from "../schema"

export type ResetKind = "monthly" | "lifetime"

export async function appendUsageReset(
  authTokenId: number,
  kind: ResetKind,
  resetAt: number,
): Promise<void> {
  const db = getDb()
  await db.insert(usageResets).values({ authTokenId, kind, resetAt })
}

export async function latestUsageReset(
  authTokenId: number,
  kind: ResetKind,
): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ ts: usageResets.resetAt })
    .from(usageResets)
    .where(
      and(eq(usageResets.authTokenId, authTokenId), eq(usageResets.kind, kind)),
    )
    .orderBy(desc(usageResets.resetAt))
    .limit(1)
  return rows[0]?.ts ?? 0
}

/**
 * Batch fetch latest reset timestamp per auth token in a single SQL query.
 * Used by the admin summary endpoint to avoid N+1 lookups.
 */
export async function latestUsageResetsByKind(
  kind: ResetKind,
): Promise<Map<number, number>> {
  const db = getDb()
  const rows = await db
    .select({
      id: usageResets.authTokenId,
      ts: sql<number>`max(${usageResets.resetAt})`,
    })
    .from(usageResets)
    .where(eq(usageResets.kind, kind))
    .groupBy(usageResets.authTokenId)
  const out = new Map<number, number>()
  for (const r of rows) {
    if (r.id == null) continue
    out.set(r.id, r.ts ?? 0)
  }
  return out
}
