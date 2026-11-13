import type { MiddlewareHandler } from "hono"

const proxyErrorTypes = new Set([
  "auth_error",
  "permission_denied",
  "rate_limit_exceeded",
  "monthly_quota_exceeded",
  "account_quota_exhausted",
  "copilot_unavailable",
])

function statusErrorType(status: number): string {
  const types: Record<number, string> = {
    401: "authentication_error",
    402: "billing_error",
    403: "permission_error",
    404: "not_found_error",
    409: "conflict_error",
    413: "request_too_large",
    429: "rate_limit_error",
    504: "timeout_error",
    529: "overloaded_error",
  }
  return types[status] ?? (status < 500 ? "invalid_request_error" : "api_error")
}

export function anthropicErrorBody(
  body: Record<string, unknown>,
  status: number,
  requestId?: string,
) {
  const error =
    typeof body.error === "object" && body.error !== null ?
      (body.error as Record<string, unknown>)
    : {}
  return {
    ...body,
    type: "error",
    error: {
      ...error,
      type:
        (
          body.type === "error"
          && typeof error.type === "string"
          && !proxyErrorTypes.has(error.type)
        ) ?
          error.type
        : statusErrorType(status),
      message:
        typeof error.message === "string" ?
          error.message
        : "An unexpected error occurred",
    },
    ...(requestId && { request_id: body.request_id ?? requestId }),
  }
}

// Also covers failures from authentication and availability middleware, before
// the Messages router has a chance to handle the request.
export function anthropicErrors(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (
      c.res.status < 400
      || !c.res.headers.get("content-type")?.includes("application/json")
    )
      return
    const body = (await c.res.json()) as Record<string, unknown>
    const requestId =
      c.res.headers.get("request-id")
      ?? c.res.headers.get("x-request-id")
      ?? `req_${crypto.randomUUID().replaceAll("-", "")}`
    c.res = new Response(
      JSON.stringify(anthropicErrorBody(body, c.res.status, requestId)),
      c.res,
    )
    c.header("request-id", requestId)
  }
}
