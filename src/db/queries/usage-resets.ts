import { and, desc, eq } from "drizzle-orm"

import { getDb } from "../client"
import { authTokens, usageResets } from "../schema"

export type ResetKind = "monthly" | "lifetime"

export async function appendUsageReset(
  authTokenId: number,
  kind: ResetKind,
  resetAt: number,
): Promise<void> {
  const db = getDb()
  await db.insert(usageResets).values({ authTokenId, kind, resetAt })
}

export function resetMonthlyQuota(authTokenId: number, resetAt: number): void {
  const db = getDb()
  db.transaction((tx) => {
    tx.update(authTokens)
      .set({ monthlyTokenUsed: 0, monthlyWindowStart: resetAt })
      .where(eq(authTokens.id, authTokenId))
      .run()
    tx.insert(usageResets)
      .values({ authTokenId, kind: "monthly", resetAt })
      .run()
  })
}

export function resetLifetimeQuota(authTokenId: number, resetAt: number): void {
  const db = getDb()
  db.transaction((tx) => {
    tx.update(authTokens)
      .set({ lifetimeTokenUsed: 0 })
      .where(eq(authTokens.id, authTokenId))
      .run()
    tx.insert(usageResets)
      .values({ authTokenId, kind: "lifetime", resetAt })
      .run()
  })
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
