import consola from "consola"

import type { CopilotInfoMessage } from "~/services/copilot/types-shared"

const LEVEL: Record<string, "warn" | "info"> = {
  model_pending_deprecation: "warn",
}

const logged = new WeakSet<object>()

/**
 * Log upstream copilot_info_messages exactly once per source object and
 * return them so the caller can decide how to propagate.
 */
export function captureInfoMessages(
  source: { copilot_info_messages?: Array<CopilotInfoMessage> } | undefined,
  ctx: { endpoint: string; model?: string | null },
): Array<CopilotInfoMessage> | undefined {
  if (!source?.copilot_info_messages?.length) return undefined
  if (logged.has(source)) return source.copilot_info_messages
  logged.add(source)

  for (const m of source.copilot_info_messages) {
    const level = LEVEL[m.code] ?? "info"
    consola[level](
      `[copilot:${m.code}] (${ctx.endpoint}${
        ctx.model ? ` model=${ctx.model}` : ""
      }) ${m.message}`,
    )
  }
  return source.copilot_info_messages
}

/**
 * Safely extract Copilot's per-request cost in nano-AIU. Returns null
 * when the field is absent, malformed, or zero (so callers can distinguish
 * "no data" from "real zero" by writing NULL into the database).
 *
 * Observed upstream behavior (Copilot API 2026-01-09):
 *   - OpenAI-family models (gpt-4o, gpt-5.x, ...) return `copilot_usage`
 *     with `total_nano_aiu` populated.
 *   - Anthropic Claude models DO NOT return `copilot_usage`; this helper
 *     correctly yields null and `/v1/messages` rows persist `cost_nano_aiu`
 *     as NULL. This is upstream policy, not a bug in our translation.
 *   - Embeddings never carry cost data.
 */
export function pickCostNanoAiu(
  source: { copilot_usage?: { total_nano_aiu?: number } } | undefined,
): number | null {
  const v = source?.copilot_usage?.total_nano_aiu
  return typeof v === "number" && v > 0 ? v : null
}
