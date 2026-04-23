import { eq, lt } from "drizzle-orm"
import crypto from "node:crypto"

import { getDb } from "../client"
import { sessions } from "../schema"

export interface SessionRow {
  id: string
  authTokenId: number | null
  isSuperAdmin: number
  expiresAt: number
  createdAt: number
}

export async function createSession(input: {
  authTokenId: number | null
  isSuperAdmin: boolean
  ttlMs: number
}): Promise<string> {
  const db = getDb()
  const id = crypto.randomBytes(32).toString("hex")
  const now = Date.now()
  await db.insert(sessions).values({
    id,
    authTokenId: input.authTokenId,
    isSuperAdmin: input.isSuperAdmin ? 1 : 0,
    expiresAt: now + input.ttlMs,
    createdAt: now,
  })
  return id
}

export async function getSessionById(
  id: string,
): Promise<SessionRow | undefined> {
  const db = getDb()
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1)
  return rows[0] as SessionRow | undefined
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb()
  await db.delete(sessions).where(eq(sessions.id, id))
}

export async function deleteSessionsForToken(
  authTokenId: number,
): Promise<void> {
  const db = getDb()
  await db.delete(sessions).where(eq(sessions.authTokenId, authTokenId))
}

export async function expireOldSessions(): Promise<void> {
  const db = getDb()
  await db.delete(sessions).where(lt(sessions.expiresAt, Date.now()))
}
