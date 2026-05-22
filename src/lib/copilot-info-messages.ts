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
 */
export function pickCostNanoAiu(
  source: { copilot_usage?: { total_nano_aiu?: number } } | undefined,
): number | null {
  const v = source?.copilot_usage?.total_nano_aiu
  return typeof v === "number" && v > 0 ? v : null
}
