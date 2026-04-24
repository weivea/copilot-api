import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { incrementLifetimeUsed, touchLastUsed } from "~/db/queries/auth-tokens"
import { insertRequestLog, maybePruneOldLogs } from "~/db/queries/request-logs"
import { state } from "~/lib/state"

interface PendingUsage {
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  model?: string | null
  recorded?: boolean
}

const STORE = "_usagePending"

function getPending(c: Context): PendingUsage {
  let p = c.get(STORE) as PendingUsage | undefined
  if (!p) {
    p = {}
    c.set(STORE, p)
  }
  return p
}

export function recordUsage(
  c: Context,
  data: Pick<
    PendingUsage,
    "promptTokens" | "completionTokens" | "totalTokens" | "model"
  >,
): void {
  const p = getPending(c)
  if (data.promptTokens !== undefined) p.promptTokens = data.promptTokens
  if (data.completionTokens !== undefined)
    p.completionTokens = data.completionTokens
  if (data.totalTokens !== undefined) p.totalTokens = data.totalTokens
  if (data.model !== undefined) p.model = data.model
}

export function usageRecorder(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now()
    let status = 200
    try {
      await next()
      status = c.res.status
    } catch (err) {
      status = 500
      throw err
    } finally {
      const tokenId = c.get("authTokenId")
      if (tokenId !== undefined) {
        const pending = (c.get(STORE) as PendingUsage | undefined) ?? {}
        const ts = Date.now()
        try {
          await insertRequestLog({
            authTokenId: tokenId,
            timestamp: ts,
            endpoint: c.req.path,
            model: pending.model ?? null,
            promptTokens: pending.promptTokens ?? null,
            completionTokens: pending.completionTokens ?? null,
            totalTokens: pending.totalTokens ?? null,
            statusCode: status,
            latencyMs: ts - startedAt,
          })
          if (pending.totalTokens && pending.totalTokens > 0) {
            await incrementLifetimeUsed(tokenId, pending.totalTokens)
          }
          await touchLastUsed(tokenId, ts)
          await maybePruneOldLogs(state.logRetentionDays * 86_400_000)
        } catch (err) {
          consola.warn("usageRecorder: failed to write log", err)
        }
      }
    }
  }
}
