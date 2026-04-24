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
  // When false, the request is logged for audit but its tokens are NOT
  // counted toward the auth token's lifetime/monthly quota. Used by purely
  // local endpoints like `/v1/messages/count_tokens` that do not consume
  // upstream Copilot quota. Defaults to true (billable) when unset.
  billable?: boolean
}

const STORE = "_usagePending"
const DEFER = "_usageDeferred"
const STARTED = "_usageStartedAt"

// Only these endpoints actually consume model resources and should be
// reflected in usage analytics (request_logs + dashboard counters).
// Anything else (models list, health checks, token info, etc.) is just
// metadata and would otherwise inflate `requests_today`.
const TRACKED_ENDPOINT_PREFIXES = [
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/messages", // covers /v1/messages and /v1/messages/count_tokens
  "/v1/embeddings",
  "/embeddings",
] as const

function isTrackedEndpoint(path: string): boolean {
  return TRACKED_ENDPOINT_PREFIXES.some((p) => path === p || path.startsWith(p))
}

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

interface WriteLogArgs {
  tokenId: number
  startedAt: number
  status: number
  endpoint: string
  pending: PendingUsage
}

async function writeLogInner(args: WriteLogArgs): Promise<void> {
  const { tokenId, startedAt, status, endpoint, pending } = args
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
    if (
      pending.billable !== false
      && pending.totalTokens
      && pending.totalTokens > 0
    ) {
      await incrementLifetimeUsed(tokenId, pending.totalTokens)
    }
    await touchLastUsed(tokenId, ts)
    await maybePruneOldLogs(state.logRetentionDays * 86_400_000)
  } catch (err) {
    consola.warn("usageRecorder: failed to write log", err)
  }
}

// Fire-and-forget wrapper: callers in request finally blocks should NOT
// await DB I/O — it adds tens of ms to user-visible latency and can keep
// SSE sockets half-open. Errors are already swallowed inside writeLogInner;
// we attach a catch as a defensive net for unhandled rejections.
function writeLog(args: WriteLogArgs): void {
  void writeLogInner(args).catch((err: unknown) => {
    consola.warn("usageRecorder: writeLog rejected", err)
  })
}

/**
 * Flush a deferred usage record. Called by streaming handlers after the
 * response stream has finished and final usage data has been collected.
 */
export function flushUsage(c: Context, status = 200): void {
  const tokenId = c.get("authTokenId")
  if (tokenId === undefined) return
  const startedAt = (c.get(STARTED) as number | undefined) ?? Date.now()
  const pending = (c.get(STORE) as PendingUsage | undefined) ?? {}
  if (pending.recorded) return
  pending.recorded = true
  writeLog({ tokenId, startedAt, status, endpoint: c.req.path, pending })
}

export function recordUsage(
  c: Context,
  data: Pick<
    PendingUsage,
    "promptTokens" | "completionTokens" | "totalTokens" | "model" | "billable"
  >,
): void {
  const p = getPending(c)
  if (data.promptTokens !== undefined) p.promptTokens = data.promptTokens
  if (data.completionTokens !== undefined)
    p.completionTokens = data.completionTokens
  if (data.totalTokens !== undefined) p.totalTokens = data.totalTokens
  if (data.model !== undefined) p.model = data.model
  if (data.billable !== undefined) p.billable = data.billable
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
      const tokenId = c.get("authTokenId")
      const deferred = c.get(DEFER) === true
      if (tokenId !== undefined && !deferred && isTrackedEndpoint(c.req.path)) {
        const pending = (c.get(STORE) as PendingUsage | undefined) ?? {}
        if (!pending.recorded) {
          pending.recorded = true
          writeLog({
            tokenId,
            startedAt,
            status,
            endpoint: c.req.path,
            pending,
          })
        }
      }
    }
  }
}
