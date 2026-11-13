import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { anthropicErrorBody } from "./anthropic-error"

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

function upstreamError(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || !("error" in value))
    return {}
  if (typeof value.error !== "object" || value.error === null) return {}
  return value.error as Record<string, unknown>
}

function errorType(status: number): string {
  if (status === 429) return "rate_limit_error"
  if (status < 500) return "invalid_request_error"
  return "api_error"
}

function anthropicUpstreamError(
  value: unknown,
  message: string,
  error: HTTPError,
) {
  const { response } = error
  const status = safeStatus(response.status)
  const original =
    typeof value === "object" && value !== null ?
      (value as Record<string, unknown>)
    : {}
  const upstream = upstreamError(value)
  const requestId =
    response.headers.get("request-id")
    ?? response.headers.get("x-request-id")
    ?? undefined
  return anthropicErrorBody(
    {
      ...original,
      error: { ...upstream, message },
    },
    status,
    requestId,
  )
}

export function forwardError(
  c: Context,
  error: unknown,
  format: "openai" | "anthropic" = "openai",
) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = error.bodyText || error.message
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
    const upstream = upstreamError(errorJson)
    const status = safeStatus(error.response.status)
    for (const header of ["retry-after", "x-request-id", "request-id"]) {
      const value = error.response.headers.get(header)
      if (value) c.header(header, value)
    }
    const body = {
      error: {
        message:
          typeof upstream.message === "string" ? upstream.message : errorText,
        type:
          typeof upstream.type === "string" ? upstream.type : errorType(status),
        param: typeof upstream.param === "string" ? upstream.param : null,
        code: typeof upstream.code === "string" ? upstream.code : null,
      },
    }
    if (format === "anthropic") {
      return c.json(
        anthropicUpstreamError(errorJson, body.error.message, error),
        status,
      )
    }
    return c.json(body, status)
  }

  return c.json(
    {
      ...(format === "anthropic" && { type: "error" }),
      error: {
        message: errorMessage(error),
        type: "api_error",
        param: null,
        code: null,
      },
    },
    500,
  )
}
