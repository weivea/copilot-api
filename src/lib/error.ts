import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response
  bodyText?: string

  constructor(message: string, response: Response, bodyText?: string) {
    super(message)
    this.response = response
    this.bodyText = bodyText
  }
}

// Status codes that legally carry a JSON body. We refuse to forward 1xx/204
// (no-content) statuses verbatim — Hono's `c.json(..., status)` would throw
// at runtime — and bucket them to 502 instead.
function safeStatus(status: number): ContentfulStatusCode {
  if (status >= 200 && status < 600 && status !== 204 && status !== 304) {
    return status as ContentfulStatusCode
  }
  return 502
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "Unknown error"
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown error"
  }
}

export function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = error.bodyText || "Unknown error"
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    // Prefer the upstream-provided structured error message when available
    // so the client sees something useful (e.g. rate-limit details), and
    // fall back to the raw body otherwise.
    const upstreamMessage =
      (
        typeof errorJson === "object"
        && errorJson !== null
        && "error" in errorJson
        && typeof (errorJson as { error?: { message?: unknown } }).error
          ?.message === "string"
      ) ?
        (errorJson as { error: { message: string } }).error.message
      : errorText
    return c.json(
      {
        error: {
          message: upstreamMessage,
          type: "error",
        },
      },
      safeStatus(error.response.status),
    )
  }

  return c.json(
    {
      error: {
        message: errorMessage(error),
        type: "error",
      },
    },
    500,
  )
}
