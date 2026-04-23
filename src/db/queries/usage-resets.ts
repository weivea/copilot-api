import { and, desc, eq } from "drizzle-orm"

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
