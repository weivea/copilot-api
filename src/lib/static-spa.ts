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

const HASH_RE = /-[\w-]{6,}\.[a-z0-9]+$/

interface CacheEntry {
  mtimeMs: number
  buf: Buffer
}

const bufCache = new Map<string, CacheEntry>()
const BUF_CACHE_MAX = 64

function readCached(filePath: string): Buffer | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  const cached = bufCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.buf
  const buf = fs.readFileSync(filePath)
  if (bufCache.size >= BUF_CACHE_MAX) {
    const firstKey = bufCache.keys().next().value
    if (firstKey !== undefined) bufCache.delete(firstKey)
  }
  bufCache.set(filePath, { mtimeMs: stat.mtimeMs, buf })
  return buf
}

function contentType(filePath: string): string {
  return (
    TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  )
}

function parseAcceptEncoding(header: string | undefined): Set<string> {
  const out = new Set<string>()
  if (!header) return out
  for (const part of header.split(",")) {
    const token = part.trim().split(";")[0]?.trim().toLowerCase()
    if (token) out.add(token)
  }
  return out
}

function pickEncoding(
  rawPath: string,
  accept: Set<string>,
): { filePath: string; encoding: string | null } {
  if (accept.has("br")) {
    const br = `${rawPath}.br`
    try {
      if (fs.statSync(br).isFile()) return { filePath: br, encoding: "br" }
    } catch {
      /* fallthrough */
    }
  }
  if (accept.has("gzip")) {
    const gz = `${rawPath}.gz`
    try {
      if (fs.statSync(gz).isFile()) return { filePath: gz, encoding: "gzip" }
    } catch {
      /* fallthrough */
    }
  }
  return { filePath: rawPath, encoding: null }
}

function weakEtag(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    return `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`
  } catch {
    return null
  }
}

function isHashedAsset(pathname: string, fileName: string): boolean {
  return pathname.startsWith("/assets/") && HASH_RE.test(fileName)
}

export function staticSpa(rootDir: string): MiddlewareHandler {
  const root = path.resolve(rootDir)
  return async (c, next) => {
    if (c.req.method !== "GET") return next()
    const url = new URL(c.req.url)
    const requested = url.pathname === "/" ? "/index.html" : url.pathname
    const candidate = path.join(root, requested)
    const resolved = path.resolve(candidate)
    if (!resolved.startsWith(root)) return next()

    let targetRaw: string
    let isIndexFallback = false
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      targetRaw = resolved
    } else {
      const indexPath = path.join(root, "index.html")
      if (!fs.existsSync(indexPath)) return next()
      targetRaw = indexPath
      isIndexFallback = true
    }

    const accept = parseAcceptEncoding(c.req.header("accept-encoding"))
    const { filePath, encoding } = pickEncoding(targetRaw, accept)
    const buf = readCached(filePath)
    if (!buf) return next()

    const headers: Record<string, string> = {
      "content-type": contentType(targetRaw),
      vary: "Accept-Encoding",
    }
    if (encoding) headers["content-encoding"] = encoding

    const fileName = path.basename(targetRaw)
    const isIndex = isIndexFallback || fileName === "index.html"

    if (isHashedAsset(url.pathname, fileName) && !isIndex) {
      headers["cache-control"] = "public, max-age=31536000, immutable"
      return c.body(new Uint8Array(buf), 200, headers)
    }

    const etag = weakEtag(targetRaw)
    if (etag) headers["etag"] = etag

    headers["cache-control"] = isIndex ? "no-cache" : "public, max-age=3600"

    if (etag && c.req.header("if-none-match") === etag) {
      return c.body(null, 304, headers)
    }

    return c.body(new Uint8Array(buf), 200, headers)
  }
}
