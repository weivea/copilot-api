import type { MiddlewareHandler } from "hono"

import consola from "consola"

export function redactKeyParam(url: string): string {
  return url.replaceAll(/([?&])key=[^&]*/g, "$1key=REDACTED")
}

export function redactingLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now()
    await next()
    const elapsed = Date.now() - start
    const safe = redactKeyParam(c.req.url)
    consola.info(`${c.req.method} ${safe} ${c.res.status} ${elapsed}ms`)
  }
}
