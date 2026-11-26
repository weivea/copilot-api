import consola from "consola"

export interface NormalizedUsage {
  promptTokens: number | null
  cachedTokens: number | null
  cacheCreationTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
  billableTokens: number | null
  usageComplete: boolean
}

interface NormalizeOptions {
  billable?: boolean
  usageComplete?: boolean
}

export interface ChatUsageLike {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  total_tokens?: number | null
  reasoning_tokens?: number | null
  prompt_tokens_details?: {
    cached_tokens?: number | null
    cache_creation_input_tokens?: number | null
  } | null
  completion_tokens_details?: {
    reasoning_tokens?: number | null
  } | null
}

interface ResponsesUsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  input_tokens_details?: {
    cached_tokens?: number | null
    cache_write_tokens?: number | null
  } | null
  output_tokens_details?: {
    reasoning_tokens?: number | null
  } | null
}

export interface AnthropicUsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
}

interface SimpleUsageLike {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  prompt_tokens_details?: {
    cached_tokens?: number | null
    cache_creation_input_tokens?: number | null
  } | null
  input_tokens_details?: {
    cached_tokens?: number | null
    cache_write_tokens?: number | null
  } | null
  completion_tokens_details?: {
    reasoning_tokens?: number | null
  } | null
  output_tokens_details?: {
    reasoning_tokens?: number | null
  } | null
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function deriveTotalTokens(
  upstreamTotal: number | null,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (upstreamTotal !== null) return upstreamTotal
  if (promptTokens !== null && completionTokens !== null) {
    return promptTokens + completionTokens
  }
  return null
}

export function computeBillableTokens(
  totalTokens: number | null,
  billable = true,
): number | null {
  if (!billable) return 0
  if (totalTokens === null) return null
  return totalTokens > 0 ? totalTokens : 0
}

function resolveNormalizedComplete(
  totalTokens: number | null,
  opts: NormalizeOptions,
): boolean {
  const billable = opts.billable ?? true
  if (billable) {
    return (opts.usageComplete ?? true) && totalTokens !== null
  }
  return opts.usageComplete ?? totalTokens !== null
}

function emptyNormalizedUsage(opts: NormalizeOptions = {}): NormalizedUsage {
  const billable = opts.billable ?? true
  return {
    promptTokens: null,
    cachedTokens: null,
    cacheCreationTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    billableTokens: billable ? null : 0,
    usageComplete: resolveNormalizedComplete(null, opts),
  }
}

function logDebugUsage(
  protocol: string,
  raw: unknown,
  normalized: NormalizedUsage,
): void {
  if (consola.level >= 4) {
    consola.debug(`Normalized ${protocol} usage:`, { raw, normalized })
  }
}

/**
 * OpenAI / Copilot `/chat/completions` usage (including Gemini, GPT, Grok,
 * and translated Claude/Responses streams).
 * - `prompt_tokens` already includes `cached_tokens` (do NOT add again).
 * - `completion_tokens` already includes `reasoning_tokens` (do NOT add again).
 * - Prefer upstream `total_tokens`; derive only if both input & output exist.
 */
export function normalizeChatUsage(
  usage: ChatUsageLike | null | undefined,
  opts: NormalizeOptions = {},
): NormalizedUsage {
  if (!usage) return emptyNormalizedUsage(opts)

  const promptTokens = numOrNull(usage.prompt_tokens)
  const cachedTokens = numOrNull(usage.prompt_tokens_details?.cached_tokens)
  const cacheCreationTokens = numOrNull(
    usage.prompt_tokens_details?.cache_creation_input_tokens,
  )
  const completionTokens = numOrNull(usage.completion_tokens)
  const reasoningTokens =
    numOrNull(usage.completion_tokens_details?.reasoning_tokens)
    ?? numOrNull(usage.reasoning_tokens)

  const totalTokens = deriveTotalTokens(
    numOrNull(usage.total_tokens),
    promptTokens,
    completionTokens,
  )

  const usageComplete = resolveNormalizedComplete(totalTokens, opts)
  const result: NormalizedUsage = {
    promptTokens,
    cachedTokens,
    cacheCreationTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    billableTokens: computeBillableTokens(totalTokens, opts.billable ?? true),
    usageComplete,
  }
  logDebugUsage("chat", usage, result)
  return result
}

/**
 * OpenAI / Copilot `/responses` usage.
 * - `input_tokens` already includes `cached_tokens`.
 * - `output_tokens` already includes `reasoning_tokens`.
 */
export function normalizeResponsesUsage(
  usage: ResponsesUsageLike | null | undefined,
  opts: NormalizeOptions = {},
): NormalizedUsage {
  if (!usage) return emptyNormalizedUsage(opts)

  const promptTokens = numOrNull(usage.input_tokens)
  const cachedTokens = numOrNull(usage.input_tokens_details?.cached_tokens)
  const cacheCreationTokens = numOrNull(
    usage.input_tokens_details?.cache_write_tokens,
  )
  const completionTokens = numOrNull(usage.output_tokens)
  const reasoningTokens = numOrNull(
    usage.output_tokens_details?.reasoning_tokens,
  )

  const totalTokens = deriveTotalTokens(
    numOrNull(usage.total_tokens),
    promptTokens,
    completionTokens,
  )

  const usageComplete = resolveNormalizedComplete(totalTokens, opts)
  const result: NormalizedUsage = {
    promptTokens,
    cachedTokens,
    cacheCreationTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    billableTokens: computeBillableTokens(totalTokens, opts.billable ?? true),
    usageComplete,
  }
  logDebugUsage("responses", usage, result)
  return result
}

function resolveAnthropicCacheCreation(
  usage: AnthropicUsageLike,
): number | null {
  const direct = numOrNull(usage.cache_creation_input_tokens)
  if (direct !== null) return direct
  if (!usage.cache_creation) return null
  const e5m = numOrNull(usage.cache_creation.ephemeral_5m_input_tokens)
  const e1h = numOrNull(usage.cache_creation.ephemeral_1h_input_tokens)
  if (e5m === null && e1h === null) return null
  return (e5m ?? 0) + (e1h ?? 0)
}

/**
 * Native Anthropic `/v1/messages` usage.
 * - `input_tokens` is non-cached input ONLY; total input is
 *   `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 * - Anthropic omits `total_tokens`, so `totalTokens` is derived ONLY when both
 *   total input and `output_tokens` are known.
 */
export function normalizeAnthropicUsage(
  usage: AnthropicUsageLike | null | undefined,
  opts: NormalizeOptions = {},
): NormalizedUsage {
  if (!usage) return emptyNormalizedUsage(opts)

  const rawInput = numOrNull(usage.input_tokens)
  const cachedTokens = numOrNull(usage.cache_read_input_tokens)
  const cacheCreationTokens = resolveAnthropicCacheCreation(usage)
  const hasAnyInput =
    rawInput !== null || cachedTokens !== null || cacheCreationTokens !== null
  const promptTokens =
    hasAnyInput ?
      (rawInput ?? 0) + (cachedTokens ?? 0) + (cacheCreationTokens ?? 0)
    : null
  const completionTokens = numOrNull(usage.output_tokens)
  const totalTokens =
    promptTokens !== null && completionTokens !== null ?
      promptTokens + completionTokens
    : null

  const usageComplete = resolveNormalizedComplete(totalTokens, opts)
  const result: NormalizedUsage = {
    promptTokens,
    cachedTokens,
    cacheCreationTokens,
    completionTokens,
    reasoningTokens: null,
    totalTokens,
    billableTokens: computeBillableTokens(totalTokens, opts.billable ?? true),
    usageComplete,
  }
  logDebugUsage("anthropic", usage, result)
  return result
}

function extractSimpleSubCounts(usage: SimpleUsageLike) {
  return {
    cachedTokens:
      numOrNull(usage.prompt_tokens_details?.cached_tokens)
      ?? numOrNull(usage.input_tokens_details?.cached_tokens),
    cacheCreationTokens:
      numOrNull(usage.prompt_tokens_details?.cache_creation_input_tokens)
      ?? numOrNull(usage.input_tokens_details?.cache_write_tokens),
    reasoningTokens:
      numOrNull(usage.completion_tokens_details?.reasoning_tokens)
      ?? numOrNull(usage.output_tokens_details?.reasoning_tokens),
  }
}

/**
 * Simple usage shape for `/embeddings`, `/decisions`, and `/images`.
 */
export function normalizeSimpleUsage(
  usage: SimpleUsageLike | null | undefined,
  opts: NormalizeOptions = {},
): NormalizedUsage {
  if (!usage) return emptyNormalizedUsage(opts)

  const promptTokens =
    numOrNull(usage.prompt_tokens) ?? numOrNull(usage.input_tokens)
  const completionTokens =
    numOrNull(usage.completion_tokens) ?? numOrNull(usage.output_tokens)
  const sub = extractSimpleSubCounts(usage)
  const totalTokens = deriveTotalTokens(
    numOrNull(usage.total_tokens),
    promptTokens,
    completionTokens,
  )

  const usageComplete = resolveNormalizedComplete(totalTokens, opts)
  const result: NormalizedUsage = {
    promptTokens,
    cachedTokens: sub.cachedTokens,
    cacheCreationTokens: sub.cacheCreationTokens,
    completionTokens,
    reasoningTokens: sub.reasoningTokens,
    totalTokens,
    billableTokens: computeBillableTokens(totalTokens, opts.billable ?? true),
    usageComplete,
  }
  logDebugUsage("simple", usage, result)
  return result
}

export function startOfCurrentMonthMs(nowMs = Date.now()): number {
  const d = new Date(nowMs)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function getEffectiveMonthlyUsed(
  row: { monthlyTokenUsed: number; monthlyWindowStart: number },
  monthStart = startOfCurrentMonthMs(),
): number {
  return row.monthlyWindowStart < monthStart ? 0 : row.monthlyTokenUsed
}
