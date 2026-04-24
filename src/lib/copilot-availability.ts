import type { MiddlewareHandler } from "hono"

import { state } from "./state"

export function requireCopilotReady(): MiddlewareHandler {
  return async (c, next) => {
    if (!state.copilotToken) {
      return c.json(
        {
          error: {
            type: "copilot_unavailable",
            message: "GitHub login required. Visit dashboard to sign in.",
          },
        },
        503,
      )
    }
    return next()
  }
}
