import type { MiddlewareHandler } from "hono"

import crypto from "node:crypto"

import { state } from "~/lib/state"

function extractToken(c: {
  req: { header: (name: string) => string | undefined }
}): string | undefined {
  const authHeader = c.req.header("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7)
  }

  return c.req.header("x-api-key")
}

function constantTimeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!state.authEnabled || !state.authToken) {
      return next()
    }

    if (c.req.path === "/") {
      return next()
    }

    const token = extractToken(c)

    if (!token) {
      return c.json(
        {
          error: {
            message:
              "Missing auth token. Set Authorization header or x-api-key header.",
            type: "auth_error",
          },
        },
        401,
      )
    }

    if (!constantTimeEqual(token, state.authToken)) {
      return c.json(
        {
          error: {
            message: "Invalid auth token.",
            type: "auth_error",
          },
        },
        401,
      )
    }

    return next()
  }
}
