import type { Context } from "hono"

import { Hono } from "hono"
import { z } from "zod"

import {
  createAuthToken,
  deleteAuthToken,
  getAuthTokenById,
  listAuthTokens,
  setLifetimeUsed,
  updateAuthToken,
} from "~/db/queries/auth-tokens"
import { deleteSessionsForToken } from "~/db/queries/sessions"
import { appendUsageReset } from "~/db/queries/usage-resets"
import { generateToken, hashToken, prefixOf } from "~/lib/auth-token-utils"
import { sessionMiddleware } from "~/lib/session"

export const adminTokensRoutes = new Hono()

// All token endpoints require admin or super
adminTokensRoutes.use("*", sessionMiddleware({ requireRole: "admin" }))

function publicRow(row: {
  id: number
  name: string
  tokenPrefix: string
  isAdmin: number
  isDisabled: number
  rpmLimit: number | null
  monthlyTokenLimit: number | null
  lifetimeTokenLimit: number | null
  lifetimeTokenUsed: number
  createdAt: number
  lastUsedAt: number | null
}) {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.tokenPrefix,
    is_admin: row.isAdmin === 1,
    is_disabled: row.isDisabled === 1,
    rpm_limit: row.rpmLimit,
    monthly_token_limit: row.monthlyTokenLimit,
    lifetime_token_limit: row.lifetimeTokenLimit,
    lifetime_token_used: row.lifetimeTokenUsed,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
  }
}

adminTokensRoutes.get("/", async (c) => {
  const rows = await listAuthTokens()
  return c.json(rows.map(publicRow))
})

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  is_admin: z.boolean().optional(),
  rpm_limit: z.number().int().positive().nullable().optional(),
  monthly_token_limit: z.number().int().positive().nullable().optional(),
  lifetime_token_limit: z.number().int().positive().nullable().optional(),
})

adminTokensRoutes.post("/", async (c) => {
  const role = c.get("sessionRole")
  const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "Invalid body" } },
      400,
    )
  }
  if (parsed.data.is_admin && role !== "super") {
    return c.json(
      {
        error: {
          type: "permission_denied",
          message: "Only super admin can create admin tokens",
        },
      },
      403,
    )
  }
  const plaintext = generateToken()
  const id = await createAuthToken({
    name: parsed.data.name,
    tokenHash: hashToken(plaintext),
    tokenPrefix: prefixOf(plaintext),
    isAdmin: parsed.data.is_admin ?? false,
    rpmLimit: parsed.data.rpm_limit ?? null,
    monthlyTokenLimit: parsed.data.monthly_token_limit ?? null,
    lifetimeTokenLimit: parsed.data.lifetime_token_limit ?? null,
    createdBy: c.get("sessionTokenId") ?? null,
  })
  const row = await getAuthTokenById(id)
  if (!row) throw new Error("post-insert lookup failed")
  return c.json({ ...publicRow(row), token: plaintext })
})

const PatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_admin: z.boolean().optional(),
  is_disabled: z.boolean().optional(),
  rpm_limit: z.number().int().positive().nullable().optional(),
  monthly_token_limit: z.number().int().positive().nullable().optional(),
  lifetime_token_limit: z.number().int().positive().nullable().optional(),
})

async function loadTargetOr404(
  c: Context,
  id: number,
): Promise<
  | { ok: true; row: NonNullable<Awaited<ReturnType<typeof getAuthTokenById>>> }
  | { ok: false; resp: Response }
> {
  const row = await getAuthTokenById(id)
  if (!row) {
    return {
      ok: false,
      resp: c.json(
        { error: { type: "not_found", message: "Token not found" } },
        404,
      ),
    }
  }
  return { ok: true, row }
}

adminTokensRoutes.patch("/:id", async (c) => {
  const role = c.get("sessionRole")
  const id = Number.parseInt(c.req.param("id"), 10)
  const r = await loadTargetOr404(c, id)
  if (!r.ok) return r.resp
  const row = r.row
  if (role !== "super" && row.isAdmin === 1) {
    return c.json(
      { error: { type: "permission_denied", message: "Cannot modify another admin" } },
      403,
    )
  }
  const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: { type: "bad_request", message: "Invalid body" } },
      400,
    )
  }
  if (parsed.data.is_admin !== undefined && role !== "super") {
    return c.json(
      { error: { type: "permission_denied", message: "Only super admin can change admin flag" } },
      403,
    )
  }
  await updateAuthToken(id, {
    name: parsed.data.name,
    isAdmin: parsed.data.is_admin,
    isDisabled: parsed.data.is_disabled,
    rpmLimit: parsed.data.rpm_limit,
    monthlyTokenLimit: parsed.data.monthly_token_limit,
    lifetimeTokenLimit: parsed.data.lifetime_token_limit,
  })
  if (parsed.data.is_disabled === true) {
    await deleteSessionsForToken(id)
  }
  const updated = await getAuthTokenById(id)
  return c.json(publicRow(updated!))
})

adminTokensRoutes.delete("/:id", async (c) => {
  const role = c.get("sessionRole")
  const id = Number.parseInt(c.req.param("id"), 10)
  const r = await loadTargetOr404(c, id)
  if (!r.ok) return r.resp
  const row = r.row
  if (role !== "super" && row.isAdmin === 1) {
    return c.json(
      { error: { type: "permission_denied", message: "Cannot delete another admin" } },
      403,
    )
  }
  await deleteSessionsForToken(id)
  await deleteAuthToken(id)
  return c.json({ ok: true })
})

adminTokensRoutes.post("/:id/reset-monthly", async (c) => {
  const role = c.get("sessionRole")
  const id = Number.parseInt(c.req.param("id"), 10)
  const r = await loadTargetOr404(c, id)
  if (!r.ok) return r.resp
  const row = r.row
  if (role !== "super" && row.isAdmin === 1) {
    return c.json(
      { error: { type: "permission_denied", message: "Cannot reset another admin" } },
      403,
    )
  }
  await appendUsageReset(id, "monthly", Date.now())
  return c.json({ ok: true })
})

adminTokensRoutes.post("/:id/reset-lifetime", async (c) => {
  const role = c.get("sessionRole")
  if (role !== "super") {
    return c.json(
      { error: { type: "permission_denied", message: "Super admin required" } },
      403,
    )
  }
  const id = Number.parseInt(c.req.param("id"), 10)
  const r = await loadTargetOr404(c, id)
  if (!r.ok) return r.resp
  await setLifetimeUsed(id, 0)
  await appendUsageReset(id, "lifetime", Date.now())
  return c.json({ ok: true })
})
