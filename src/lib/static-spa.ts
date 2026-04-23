import type { MiddlewareHandler } from "hono"

import fs from "node:fs"
import path from "node:path"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function contentType(filePath: string): string {
  return (
    TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  )
}

export function staticSpa(rootDir: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET") return next()
    const url = new URL(c.req.url)
    const requested = url.pathname === "/" ? "/index.html" : url.pathname
    const candidate = path.join(rootDir, requested)
    const resolved = path.resolve(candidate)
    if (!resolved.startsWith(path.resolve(rootDir))) return next()
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const buf = fs.readFileSync(resolved)
      return c.body(buf, 200, { "content-type": contentType(resolved) })
    }
    const indexPath = path.join(rootDir, "index.html")
    if (fs.existsSync(indexPath)) {
      const buf = fs.readFileSync(indexPath)
      return c.body(buf, 200, { "content-type": "text/html; charset=utf-8" })
    }
    return next()
  }
}
