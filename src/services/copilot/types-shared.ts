/**
 * Copilot per-request cost breakdown. Units are nano-AIU (10^-9 AIU).
 * Stable starting with API_VERSION 2026-01-09.
 */
export interface CopilotUsage {
  token_details: Array<{
    batch_size: number
    cost_per_batch: number
    token_count: number
    token_type: "input" | "cache_read" | "cache_write" | "output" | string
  }>
  total_nano_aiu: number
}

/**
 * Out-of-band notifications from upstream. Known codes today:
 *   - "model_pending_deprecation"
 * Open string union so unknown codes still type-check.
 */
export interface CopilotInfoMessage {
  code: "model_pending_deprecation" | string
  message: string
}
