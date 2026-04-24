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
const DEFER = "_usageDeferred"
const STARTED = "_usageStartedAt"

function getPending(c: Context): PendingUsage {
  let p = c.get(STORE) as PendingUsage | undefined
  if (!p) {
    p = {}
    c.set(STORE, p)
  }
  return p
}

/**
 * Streaming handlers should call this BEFORE returning the SSE response so
 * that `usageRecorder` skips the automatic flush. The handler then owns
 * writing the log inside its own finally via `flushUsage()`.
 */
export function deferUsage(c: Context): void {
  c.set(DEFER, true)
}

async function writeLog(
  tokenId: number,
  startedAt: number,
  status: number,
  endpoint: string,
  pending: PendingUsage,
): Promise<void> {
  const ts = Date.now()
  try {
    await insertRequestLog({
      authTokenId: tokenId,
      timestamp: ts,
      endpoint,
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

/**
 * Flush a deferred usage record. Called by streaming handlers after the
 * response stream has finished and final usage data has been collected.
 */
export async function flushUsage(c: Context, status = 200): Promise<void> {
  const tokenId = c.get("authTokenId") as number | undefined
  if (tokenId === undefined) return
  const startedAt = (c.get(STARTED) as number | undefined) ?? Date.now()
  const pending = (c.get(STORE) as PendingUsage | undefined) ?? {}
  if (pending.recorded) return
  pending.recorded = true
  await writeLog(tokenId, startedAt, status, c.req.path, pending)
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
    c.set(STARTED, startedAt)
    let status = 200
    try {
      await next()
      status = c.res.status
    } catch (err) {
      status = 500
      throw err
    } finally {
      const tokenId = c.get("authTokenId") as number | undefined
      const deferred = c.get(DEFER) === true
      if (tokenId !== undefined && !deferred) {
        const pending = (c.get(STORE) as PendingUsage | undefined) ?? {}
        if (!pending.recorded) {
          pending.recorded = true
          await writeLog(tokenId, startedAt, status, c.req.path, pending)
        }
      }
    }
  }
}
