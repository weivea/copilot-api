import { eq } from "drizzle-orm"

import { getDb } from "../client"
import { authTokens } from "../schema"

export interface NewAuthToken {
  name: string
  tokenHash: string
  tokenPrefix: string
  isAdmin?: boolean
  rpmLimit?: number | null
  monthlyTokenLimit?: number | null
  lifetimeTokenLimit?: number | null
  createdBy?: number | null
}

export interface AuthTokenRow {
  id: number
  name: string
  tokenHash: string
  tokenPrefix: string
  isAdmin: number
  isDisabled: number
  rpmLimit: number | null
  monthlyTokenLimit: number | null
  lifetimeTokenLimit: number | null
  lifetimeTokenUsed: number
  createdAt: number
  createdBy: number | null
  lastUsedAt: number | null
}

export async function createAuthToken(
  input: NewAuthToken,
): Promise<number> {
  const db = getDb()
  const [row] = await db
    .insert(authTokens)
    .values({
      name: input.name,
      tokenHash: input.tokenHash,
      tokenPrefix: input.tokenPrefix,
      isAdmin: input.isAdmin ? 1 : 0,
      rpmLimit: input.rpmLimit ?? null,
      monthlyTokenLimit: input.monthlyTokenLimit ?? null,
      lifetimeTokenLimit: input.lifetimeTokenLimit ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: Date.now(),
    })
    .returning({ id: authTokens.id })
  if (!row) throw new Error("insert failed")
  return row.id
}

export async function findAuthTokenByHash(
  hash: string,
): Promise<AuthTokenRow | undefined> {
  const db = getDb()
  const rows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.tokenHash, hash))
    .limit(1)
  return rows[0] as AuthTokenRow | undefined
}

export async function getAuthTokenById(
  id: number,
): Promise<AuthTokenRow | undefined> {
  const db = getDb()
  const rows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.id, id))
    .limit(1)
  return rows[0] as AuthTokenRow | undefined
}

export async function listAuthTokens(): Promise<Array<AuthTokenRow>> {
  const db = getDb()
  return (await db.select().from(authTokens)) as Array<AuthTokenRow>
}

export interface UpdateAuthToken {
  name?: string
  isAdmin?: boolean
  isDisabled?: boolean
  rpmLimit?: number | null
  monthlyTokenLimit?: number | null
  lifetimeTokenLimit?: number | null
}

export async function updateAuthToken(
  id: number,
  patch: UpdateAuthToken,
): Promise<void> {
  const db = getDb()
  const values: Record<string, unknown> = {}
  if (patch.name !== undefined) values.name = patch.name
  if (patch.isAdmin !== undefined) values.isAdmin = patch.isAdmin ? 1 : 0
  if (patch.isDisabled !== undefined)
    values.isDisabled = patch.isDisabled ? 1 : 0
  if (patch.rpmLimit !== undefined) values.rpmLimit = patch.rpmLimit
  if (patch.monthlyTokenLimit !== undefined)
    values.monthlyTokenLimit = patch.monthlyTokenLimit
  if (patch.lifetimeTokenLimit !== undefined)
    values.lifetimeTokenLimit = patch.lifetimeTokenLimit
  if (Object.keys(values).length === 0) return
  await db.update(authTokens).set(values).where(eq(authTokens.id, id))
}

export async function deleteAuthToken(id: number): Promise<void> {
  const db = getDb()
  await db.delete(authTokens).where(eq(authTokens.id, id))
}

export async function setLifetimeUsed(
  id: number,
  value: number,
): Promise<void> {
  const db = getDb()
  await db
    .update(authTokens)
    .set({ lifetimeTokenUsed: value })
    .where(eq(authTokens.id, id))
}

export async function incrementLifetimeUsed(
  id: number,
  delta: number,
): Promise<void> {
  if (delta <= 0) return
  const db = getDb()
  const sql = `UPDATE auth_tokens SET lifetime_token_used = lifetime_token_used + ? WHERE id = ?`
  // Drizzle exposes underlying sqlite for raw exec
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(db as any).$client.prepare(sql).run(delta, id)
}

export async function touchLastUsed(
  id: number,
  timestamp: number,
): Promise<void> {
  const db = getDb()
  await db
    .update(authTokens)
    .set({ lastUsedAt: timestamp })
    .where(eq(authTokens.id, id))
}
