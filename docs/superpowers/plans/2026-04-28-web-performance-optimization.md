# Web Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut dashboard SPA first-paint cost via brotli/gzip precompression, vendor chunking, route-level lazy loading, and long-cache headers in `staticSpa`.

**Architecture:** Build-time changes in `frontend/` (Vite plugin + manualChunks + React.lazy) emit hashed chunks alongside `.br` and `.gz` siblings into `dist/public/assets/`. Runtime `staticSpa` middleware negotiates `Accept-Encoding`, picks the precompressed sibling, and applies `immutable` cache headers to `/assets/*` and `no-cache` + ETag to `index.html`.

**Tech Stack:** Vite 5, React 18, react-router-dom 6, Hono 4, Bun test runner, vite-plugin-compression.

**Spec:** `docs/superpowers/specs/2026-04-28-web-perf-optimization-design.md`

---

## File Structure

**Backend (`src/`)**
- Modify: `src/lib/static-spa.ts` — replace body with negotiation + caching pipeline. Public API unchanged.

**Frontend build (`frontend/`)**
- Modify: `frontend/package.json` — add `vite-plugin-compression` to `devDependencies`.
- Modify: `frontend/vite.config.ts` — register two compression plugin instances; add `manualChunks`.
- Modify: `frontend/src/App.tsx` — replace static imports with `React.lazy` for 5 pages; add `<Suspense>`.
- Modify: `frontend/src/pages/{Usage,Tokens,Models,Settings,Docs}.tsx` — add `export default` aliases.
- Create: `frontend/src/components/PageSkeleton.tsx` — minimal Suspense fallback.

**Tests**
- Create: `tests/static-spa.test.ts` — fixture-driven middleware tests.

---

## Task 1: Add `export default` aliases to lazy-loaded pages

**Files:**
- Modify: `frontend/src/pages/Usage.tsx` (append after existing named export)
- Modify: `frontend/src/pages/Tokens.tsx`
- Modify: `frontend/src/pages/Models.tsx`
- Modify: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/pages/Docs.tsx`

The named `export function <Name>()` stays intact (other code may import it). We add a default export so `lazy(() => import("./pages/<Name>"))` works without a `.then(m => ({ default: m.<Name> }))` shim.

- [ ] **Step 1: Append default export to each page file**

For each of Usage, Tokens, Models, Settings, Docs, append at end of file:

```tsx
export default Usage
```
(use the matching component name)

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS, no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/{Usage,Tokens,Models,Settings,Docs}.tsx
git commit -m "refactor(frontend): add default exports to lazy-loadable pages"
```

---

## Task 2: Create PageSkeleton fallback component

**Files:**
- Create: `frontend/src/components/PageSkeleton.tsx`

- [ ] **Step 1: Create the component**

```tsx
export function PageSkeleton() {
  return (
    <div
      style={{
        padding: "2rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted, #888)",
        minHeight: "200px",
      }}
    >
      Loading…
    </div>
  )
}

export default PageSkeleton
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PageSkeleton.tsx
git commit -m "feat(frontend): add PageSkeleton fallback for Suspense"
```

---

## Task 3: Convert App.tsx routes to React.lazy

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Replace file contents**

```tsx
import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"

import { Layout } from "./components/Layout"
import { PageSkeleton } from "./components/PageSkeleton"
import { useAuth } from "./contexts/AuthContext"
import { GithubAuth } from "./pages/GithubAuth"
import { Login } from "./pages/Login"

const Usage = lazy(() => import("./pages/Usage"))
const Tokens = lazy(() => import("./pages/Tokens"))
const Models = lazy(() => import("./pages/Models"))
const Settings = lazy(() => import("./pages/Settings"))
const Docs = lazy(() => import("./pages/Docs"))

export function App() {
  const { me, loading } = useAuth()
  if (loading) return <div className="center">Loading…</div>
  if (!me) return <Login />
  return (
    <Layout>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/" element={<Navigate to="/usage" replace />} />
          <Route path="/overview" element={<Navigate to="/usage" replace />} />
          <Route
            path="/tokens"
            element={
              me.role === "user" ? <Navigate to="/usage" replace /> : <Tokens />
            }
          />
          <Route path="/usage" element={<Usage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/copilot-models" element={<Models />} />
          <Route path="/docs" element={<Docs />} />
          <Route
            path="/github-auth"
            element={
              me.role === "super" ?
                <GithubAuth />
              : <Navigate to="/usage" replace />
            }
          />
          <Route path="*" element={<Navigate to="/usage" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}
```

- [ ] **Step 2: Build the frontend**

Run: `bun run build:frontend`
Expected: Build succeeds. `dist/public/assets/` now contains multiple `*.js` files (entry + Usage + Tokens + Models + Settings + Docs chunks at minimum).

- [ ] **Step 3: List output to confirm splitting**

Run: `ls -la dist/public/assets/`
Expected: At least 6 distinct `.js` files (entry + 5 page chunks). Entry is smaller than the previous monolithic 580K bundle.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "perf(frontend): lazy-load non-auth route components"
```

---

## Task 4: Add manualChunks vendor splitting

**Files:**
- Modify: `frontend/vite.config.ts`

- [ ] **Step 1: Replace file contents**

```ts
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor"
          }
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return "router"
          }
          if (/[\\/]node_modules[\\/](recharts|d3-[^/\\]+)[\\/]/.test(id)) {
            return "charts"
          }
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      "/admin/api": "http://localhost:4141",
    },
  },
})
```

- [ ] **Step 2: Build and inspect**

Run: `bun run build:frontend && ls -la dist/public/assets/ | grep -E '\.(js|css)$'`
Expected: Output includes files matching `react-vendor-*.js`, `router-*.js`, `charts-*.js`, plus per-page chunks. Charts chunk is the largest (~250-300K raw).

- [ ] **Step 3: Verify entry chunk is small**

Run: `ls -la dist/public/assets/index-*.js`
Expected: Entry `index-*.js` is well under 200K (typically 30-80K — it now contains only app shell + Login + GithubAuth + Layout).

- [ ] **Step 4: Commit**

```bash
git add frontend/vite.config.ts
git commit -m "perf(frontend): split react/router/recharts into separate vendor chunks"
```

---

## Task 5: Add vite-plugin-compression to emit .br and .gz

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.ts`

- [ ] **Step 1: Install plugin**

Run: `cd frontend && bun add -d vite-plugin-compression && cd ..`
Expected: `frontend/package.json` `devDependencies` now contains `vite-plugin-compression`.

- [ ] **Step 2: Update vite.config.ts to register two compression instances**

Replace `frontend/vite.config.ts` with:

```ts
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import viteCompression from "vite-plugin-compression"

export default defineConfig({
  plugins: [
    react(),
    viteCompression({
      algorithm: "brotliCompress",
      ext: ".br",
      threshold: 1024,
      deleteOriginFile: false,
    }),
    viteCompression({
      algorithm: "gzip",
      ext: ".gz",
      threshold: 1024,
      deleteOriginFile: false,
    }),
  ],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor"
          }
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return "router"
          }
          if (/[\\/]node_modules[\\/](recharts|d3-[^/\\]+)[\\/]/.test(id)) {
            return "charts"
          }
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      "/admin/api": "http://localhost:4141",
    },
  },
})
```

- [ ] **Step 3: Build and verify precompressed siblings**

Run: `bun run build:frontend && ls dist/public/assets/ | grep -E '\.(br|gz)$' | head -20`
Expected: For each `*.js` and `*.css` larger than 1KB there exist `.br` and `.gz` siblings.

- [ ] **Step 4: Spot-check size reduction**

Run: `ls -la dist/public/assets/charts-*.js dist/public/assets/charts-*.js.br dist/public/assets/charts-*.js.gz`
Expected: `.br` is ~25-30% of raw size; `.gz` is ~30-35% of raw size.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/bun.lock frontend/vite.config.ts
git commit -m "perf(frontend): emit brotli and gzip precompressed assets"
```

---

## Task 6: Write failing tests for new staticSpa behavior

**Files:**
- Create: `tests/static-spa.test.ts`

These tests will fail against the current `staticSpa` (no compression negotiation, no cache headers). They drive the rewrite.

- [ ] **Step 1: Write the test file**

```ts
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { staticSpa } from "~/lib/static-spa"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "static-spa-"))

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, "assets"), { recursive: true })
  fs.writeFileSync(path.join(ROOT, "index.html"), "<html>app</html>")
  fs.writeFileSync(
    path.join(ROOT, "assets", "index-abc123.js"),
    "console.log('raw')",
  )
  fs.writeFileSync(
    path.join(ROOT, "assets", "index-abc123.js.br"),
    "BR-BYTES",
  )
  fs.writeFileSync(
    path.join(ROOT, "assets", "index-abc123.js.gz"),
    "GZ-BYTES",
  )
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

function makeApp() {
  const app = new Hono()
  app.use(staticSpa(ROOT))
  return app
}

describe("staticSpa", () => {
  test("serves brotli when Accept-Encoding includes br", async () => {
    const res = await makeApp().request("/assets/index-abc123.js", {
      headers: { "accept-encoding": "br, gzip" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBe("br")
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(res.headers.get("vary")).toContain("Accept-Encoding")
    expect(res.headers.get("content-type")).toContain("javascript")
    expect(await res.text()).toBe("BR-BYTES")
  })

  test("serves gzip when only gzip accepted", async () => {
    const res = await makeApp().request("/assets/index-abc123.js", {
      headers: { "accept-encoding": "gzip" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBe("gzip")
    expect(await res.text()).toBe("GZ-BYTES")
  })

  test("serves raw bytes when no Accept-Encoding", async () => {
    const res = await makeApp().request("/assets/index-abc123.js")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(await res.text()).toBe("console.log('raw')")
  })

  test("index.html uses no-cache and ETag", async () => {
    const res = await makeApp().request("/")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-cache")
    const etag = res.headers.get("etag")
    expect(etag).toBeTruthy()
    expect(etag).toMatch(/^W\/".+"$/)
  })

  test("returns 304 when If-None-Match matches index ETag", async () => {
    const first = await makeApp().request("/")
    const etag = first.headers.get("etag")!
    const second = await makeApp().request("/", {
      headers: { "if-none-match": etag },
    })
    expect(second.status).toBe(304)
    expect(await second.text()).toBe("")
  })

  test("path traversal is rejected", async () => {
    const res = await makeApp().request("/../../etc/passwd")
    expect(res.status).toBe(404)
  })

  test("missing asset falls back to index.html", async () => {
    const res = await makeApp().request("/nope-not-real")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("<html>app</html>")
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test tests/static-spa.test.ts`
Expected: FAIL — current middleware doesn't set `content-encoding`, `cache-control: immutable`, `vary`, or `etag`.

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/static-spa.test.ts
git commit -m "test: add failing tests for compression and caching in staticSpa"
```

---

## Task 7: Rewrite staticSpa middleware to pass tests

**Files:**
- Modify: `src/lib/static-spa.ts`

- [ ] **Step 1: Replace file contents**

```ts
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

const HASH_RE = /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/

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
    if (
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isFile()
    ) {
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
      "vary": "Accept-Encoding",
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

    if (isIndex) {
      headers["cache-control"] = "no-cache"
    } else {
      headers["cache-control"] = "public, max-age=3600"
    }

    if (etag && c.req.header("if-none-match") === etag) {
      return c.body(null, 304, headers)
    }

    return c.body(new Uint8Array(buf), 200, headers)
  }
}
```

- [ ] **Step 2: Run static-spa tests**

Run: `bun test tests/static-spa.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS, no regressions.

- [ ] **Step 4: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: Both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/static-spa.ts
git commit -m "perf(server): negotiate Accept-Encoding and apply cache headers in staticSpa"
```

---

## Task 8: End-to-end verification

No code changes; this task verifies the integrated stack works.

- [ ] **Step 1: Full build**

Run: `bun run build`
Expected: tsdown + frontend build both succeed; `dist/public/assets/` has hashed chunks plus `.br` / `.gz` siblings.

- [ ] **Step 2: Start production server**

Run: `bun run start &` (record PID, e.g. `SERVER_PID=$!`)
Wait ~2 seconds for server boot.

- [ ] **Step 3: Verify brotli is served for an asset**

Run: `curl -sI -H 'Accept-Encoding: br, gzip' http://localhost:4141/assets/$(ls dist/public/assets/ | grep -E '^index-.*\.js$' | head -1)`
Expected output contains:
- `HTTP/1.1 200 OK`
- `content-encoding: br`
- `cache-control: public, max-age=31536000, immutable`
- `vary: Accept-Encoding`

- [ ] **Step 4: Verify gzip fallback**

Run: same as Step 3 but with `Accept-Encoding: gzip`.
Expected: `content-encoding: gzip`, same caching headers.

- [ ] **Step 5: Verify index.html caching**

Run: `curl -sI http://localhost:4141/`
Expected output contains:
- `cache-control: no-cache`
- `etag: W/"...`

Then re-request with the ETag:
Run: `ETAG=$(curl -sI http://localhost:4141/ | grep -i ^etag | sed 's/^[^:]*: //I' | tr -d '\r\n'); curl -sI -H "If-None-Match: $ETAG" http://localhost:4141/`
Expected: `HTTP/1.1 304 Not Modified`.

- [ ] **Step 6: Stop server**

Run: `kill $SERVER_PID 2>/dev/null || true`

- [ ] **Step 7: Verify package script still works**

Run: `bun run package`
Expected: succeeds, produces `dist/copilot-api-v*-linux-x64.tar.gz` (or other host platform).

- [ ] **Step 8: Verify tarball contains precompressed assets**

Run: `tar -tzf dist/copilot-api-v*-*.tar.gz | grep -E 'release/dist/public/assets/.*\.(br|gz)$' | head -10`
Expected: lists `.br` and `.gz` files for js and css assets.

- [ ] **Step 9: Final commit (if anything changed) or note completion**

If only verification ran, no commit needed. Otherwise:

```bash
git add -A
git commit -m "chore: verify packaging pipeline includes precompressed assets"
```

---

## Self-Review Notes

- **Spec coverage:** Sections 5.1 (Vite config) → Tasks 4 & 5; 5.2 (App.tsx + lazy + skeleton) → Tasks 1, 2, 3; 5.3 (staticSpa rewrite) → Task 7; testing strategy §8 → Task 6; build & release compatibility §9 → Task 8 step 7-8; acceptance criteria §10 all verified in Task 8.
- **Type consistency:** `staticSpa` signature unchanged. `PageSkeleton` exports both named and default. All page files keep their existing named exports.
- **No placeholders:** Every code step includes complete code; every command has expected output.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-28-web-performance-optimization.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
