import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import {
  maybePruneOldLogs,
  recordRequestAndQuota,
} from "~/db/queries/request-logs"
import { state } from "~/lib/state"
import {
  computeBillableTokens,
  type NormalizedUsage,
} from "~/lib/usage-normalizer"

interface PendingUsage {
  promptTokens?: number | null
  cachedTokens?: number | null
  cacheCreationTokens?: number | null
  completionTokens?: number | null
  reasoningTokens?: number | null
  totalTokens?: number | null
  billableTokens?: number | null
  usageComplete?: boolean
  costNanoAiu?: number | null
  model?: string | null
  recorded?: boolean
  // When false, the request is logged for audit but its tokens are NOT
  // counted toward the auth token's lifetime/monthly quota. Used by
  // non-generating endpoints like `/v1/messages/count_tokens`.
  // Defaults to true (billable) when unset.
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
  "/v1/responses",
  "/responses",
  "/v1/decisions",
  "/decisions",
  "/v1/images/generations",
  "/images/generations",
  "/v1/images/edits",
  "/images/edits",
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
  const billable = pending.billable !== false
  const totalTokens = pending.totalTokens ?? null
  const billableTokens = computeBillableTokens(
    pending.billableTokens === undefined ? totalTokens : pending.billableTokens,
    billable,
  )
  const usageComplete =
    pending.usageComplete ?? (totalTokens !== null && status < 400)
  try {
    recordRequestAndQuota({
      authTokenId: tokenId,
      timestamp: ts,
      endpoint,
      model: pending.model ?? null,
      promptTokens: pending.promptTokens ?? null,
      cachedTokens: pending.cachedTokens ?? null,
      cacheCreationTokens: pending.cacheCreationTokens ?? null,
      completionTokens: pending.completionTokens ?? null,
      reasoningTokens: pending.reasoningTokens ?? null,
      totalTokens,
      billableTokens,
      usageComplete,
      costNanoAiu: pending.costNanoAiu ?? null,
      statusCode: status,
      latencyMs: ts - startedAt,
      billable,
    })
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

export type RecordUsageInput = Pick<
  PendingUsage,
  | "promptTokens"
  | "cachedTokens"
  | "cacheCreationTokens"
  | "completionTokens"
  | "reasoningTokens"
  | "totalTokens"
  | "billableTokens"
  | "usageComplete"
  | "costNanoAiu"
  | "model"
  | "billable"
>

export function recordUsage(c: Context, data: RecordUsageInput): void {
  const p = getPending(c)
  for (const key of [
    "promptTokens",
    "cachedTokens",
    "cacheCreationTokens",
    "completionTokens",
    "reasoningTokens",
    "totalTokens",
    "billableTokens",
    "usageComplete",
    "costNanoAiu",
    "model",
    "billable",
  ] as const) {
    if (data[key] !== undefined) {
      ;(p as Record<string, unknown>)[key] = data[key]
    }
  }
}

export function recordNormalizedUsage(
  c: Context,
  opts: {
    model?: string | null
    usage: NormalizedUsage
    costNanoAiu?: number | null
    billable?: boolean
  },
): void {
  recordUsage(c, {
    model: opts.model,
    promptTokens: opts.usage.promptTokens,
    cachedTokens: opts.usage.cachedTokens,
    cacheCreationTokens: opts.usage.cacheCreationTokens,
    completionTokens: opts.usage.completionTokens,
    reasoningTokens: opts.usage.reasoningTokens,
    totalTokens: opts.usage.totalTokens,
    billableTokens: opts.usage.billableTokens,
    usageComplete: opts.usage.usageComplete,
    costNanoAiu: opts.costNanoAiu,
    billable: opts.billable,
  })
}

export function usageRecorder(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now()
    c.set(STARTED, startedAt)
    let status = 500
    try {
      await next()
      status = c.res.status
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
