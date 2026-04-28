# Web Performance Optimization — Design Spec

- **Date:** 2026-04-28
- **Scope:** Frontend dashboard (`frontend/`) and static file serving middleware (`src/lib/static-spa.ts`)
- **Status:** Approved (pending user review of this document)

## 1. Background

The dashboard SPA currently builds to a single ~580K JS bundle (`dist/public/assets/index-*.js`) plus 8K CSS. The `staticSpa` middleware that serves these files:

- Sets no caching headers (no `Cache-Control`, no `ETag`, no `Last-Modified`)
- Performs no compression (no gzip, no brotli)
- Reads files synchronously from disk on every request

Result: every reload re-downloads the full bundle uncompressed; first paint is dominated by a single large JS file containing react, react-router, recharts, and all 7 page components.

## 2. Goals

1. Cut first-paint JS transfer size by ~70% via brotli precompression.
2. Cut first-paint JS parsing cost by splitting vendor and lazy-loading non-critical routes.
3. Make subsequent reloads near-instant via long-lived `immutable` caching of hashed assets.
4. Keep the existing release pipeline (`bun run package`, GitHub Actions, Docker) working with no changes to those scripts.

## 3. Non-Goals (YAGNI)

- No service worker / PWA.
- No image optimization (project has effectively no images).
- No CDN integration.
- No changes to backend API routes or auth middleware.
- No refactor of frontend components beyond what lazy-loading requires.

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Build time (frontend/vite.config.ts)                     │
│  ├─ rollup manualChunks                                 │
│  │    ├─ react-vendor   (react, react-dom)              │
│  │    ├─ router         (react-router-dom)              │
│  │    └─ charts         (recharts)                      │
│  ├─ React.lazy() for Usage / Tokens / Models /          │
│  │   Settings / Docs (Login & GithubAuth stay sync)     │
│  └─ vite-plugin-compression × 2 → emit *.br and *.gz    │
└─────────────────────────────────────────────────────────┘
                          ↓ dist/public/assets/
┌─────────────────────────────────────────────────────────┐
│ Runtime (src/lib/static-spa.ts)                          │
│  ├─ Negotiate Accept-Encoding → pick .br > .gz > raw    │
│  ├─ /assets/* (hashed): Cache-Control immutable, 1y     │
│  ├─ index.html:        Cache-Control no-cache + ETag    │
│  └─ Other static:      max-age=3600 + ETag              │
└─────────────────────────────────────────────────────────┘
```

## 5. Component Designs

### 5.1 `frontend/vite.config.ts`

- Add devDependency `vite-plugin-compression` to `frontend/package.json`.
- Plugin configuration:
  - One instance with `algorithm: "brotliCompress"`, `ext: ".br"`, `threshold: 1024`, `deleteOriginFile: false`.
  - One instance with `algorithm: "gzip"`, `ext: ".gz"`, `threshold: 1024`, `deleteOriginFile: false`.
- `build.rollupOptions.output.manualChunks` returns:
  - `react-vendor` for ids matching `node_modules/(react|react-dom|scheduler)/`
  - `router` for `node_modules/(react-router|react-router-dom|@remix-run)/`
  - `charts` for `node_modules/recharts/` and `node_modules/d3-`
  - default (entry chunk) for everything else
- Keep `outDir: "../dist/public"`, `emptyOutDir: true`.

### 5.2 `frontend/src/App.tsx`

- Imports:
  - `Login`, `GithubAuth`, `Layout`, hooks remain static imports.
  - `Usage`, `Tokens`, `Models`, `Settings`, `Docs` become `lazy(() => import("./pages/<Name>"))`.
- Each lazy page module must export the component as default. Where the existing component is a named export, add `export default <Name>` alongside (do not remove the named export — other tests/imports may rely on it).
- Wrap the `<Routes>` tree inside `<Layout>` with `<Suspense fallback={<PageSkeleton />}>`.
- New file `frontend/src/components/PageSkeleton.tsx`: a minimal placeholder using existing CSS variables (no new deps) to avoid layout flash during chunk fetch.

### 5.3 `src/lib/static-spa.ts` (rewrite)

Public API unchanged: `staticSpa(rootDir: string): MiddlewareHandler`.

Internal pipeline per GET request:

1. **Resolve candidate path** (preserve current path traversal guard).
2. **Determine kind**:
   - `assets`: pathname starts with `/assets/` and filename matches `/-[A-Za-z0-9_-]{6,}\./` (Vite hash pattern).
   - `index`: candidate resolves to `index.html` or no file matched (SPA fallback).
   - `other`: anything else (favicon, robots.txt, etc.).
3. **Encoding negotiation**:
   - Parse `Accept-Encoding` header into a set.
   - If set contains `br` and `${resolved}.br` exists → serve it with `Content-Encoding: br`.
   - Else if set contains `gzip` and `${resolved}.gz` exists → serve it with `Content-Encoding: gzip`.
   - Else serve raw `resolved`.
   - Always set `Vary: Accept-Encoding` and `Content-Type` based on the *original* file extension.
4. **Cache headers** by kind:
   - `assets` → `Cache-Control: public, max-age=31536000, immutable`. No ETag (immutable makes it redundant).
   - `index` → `Cache-Control: no-cache`, weak ETag = `W/"${size}-${mtimeMs}"`. If `If-None-Match` matches, return 304 with the same headers and empty body.
   - `other` → `Cache-Control: public, max-age=3600`, same ETag scheme.
5. **In-process buffer cache**: a `Map<string, { mtimeMs: number; buf: Buffer }>` keyed by `${resolvedWithEncoding}`. On hit with matching `mtimeMs`, skip `readFileSync`. Cap at ~64 entries (LRU; small SPA, naive Map.delete-on-set is fine).

Behavior preserved: `c.req.method !== "GET"` → `next()`. Path traversal still rejected. SPA fallback to `index.html` still works. New behavior is additive; if a `.br`/`.gz` sibling does not exist, fall back to raw with no error.

## 6. Data Flow Examples

```
Cold first paint:
  GET /                       200 index.html  (no-cache, ETag, Content-Encoding: br)
  GET /assets/index-*.css     200 (immutable, br)
  GET /assets/index-*.js      200 (immutable, br)  ~50K entry
  GET /assets/react-vendor-*  200 (immutable, br)
  GET /assets/router-*        200 (immutable, br)

Navigate to /usage (logged in):
  GET /assets/Usage-*.js      200 (immutable, br)
  GET /assets/charts-*.js     200 (immutable, br)  recharts, lazy

Reload after 1 day:
  GET /                       304 (ETag matches)
  All /assets/* served by browser disk cache; zero network for them.
```

## 7. Error Handling

- Missing `.br`/`.gz` sibling → silent fallback to raw file.
- `Accept-Encoding` header absent or `identity;q=1, *;q=0` → serve raw, no `Content-Encoding`.
- `fs.statSync` failure for ETag → omit ETag, still serve 200 with body.
- `vite-plugin-compression` not installed (dev) → build still succeeds, runtime simply never finds `.br`/`.gz` and serves raw.

## 8. Testing Strategy

New file `tests/static-spa.test.ts` (Bun test):

- Build a temporary fixture root with `app.js`, `app.js.br`, `app.js.gz`, `assets/index-abc123.js` (+ `.br`, `.gz`), `index.html`.
- Cases:
  1. `GET /assets/index-abc123.js` with `Accept-Encoding: br, gzip` → 200, body == `.br` bytes, `Content-Encoding: br`, `Cache-Control` includes `immutable`, `Vary: Accept-Encoding`.
  2. Same path, `Accept-Encoding: gzip` only → 200, body == `.gz` bytes, `Content-Encoding: gzip`.
  3. Same path, no `Accept-Encoding` → 200, body == raw bytes, no `Content-Encoding`.
  4. `GET /` → 200 `index.html`, `Cache-Control: no-cache`, ETag present.
  5. Repeat (4) with matching `If-None-Match` → 304, no body.
  6. `GET /../../etc/passwd` → falls through to `next()` (not served).
  7. `GET /assets/missing.js` → SPA fallback to `index.html`.
- Use `node:os.tmpdir()` for fixtures; clean up in `afterAll`.

Optional bundle-budget script (not blocking):

- After `bun run build:frontend`, assert `dist/public/assets/index-*.js` (entry only, not vendor) is below 200 KB raw / 70 KB brotli. Wire as `bun run build:check` for manual use.

## 9. Build & Release Compatibility

- `vite-plugin-compression` MUST be added to `frontend/package.json` `devDependencies`, NOT to root `package.json`. The release pipeline runs `cd frontend && bun install && bun run build`; root deps are not visible there.
- `scripts/package.ts` requires no changes. Its `fs.cp(publicSrc, …, { recursive: true })` already copies all files under `dist/public/`, so newly emitted `*.br` and `*.gz` siblings ride along automatically.
- GitHub Actions workflows require no changes.
- Bun `--compile` binary embeds `src/lib/static-spa.ts`; the rewritten middleware will be compiled in. Frontend assets continue to be read from disk via `path.resolve(path.dirname(process.execPath), "..", "dist", "public")` and now find the `.br`/`.gz` siblings.
- Docker image inherits the same `bun run build` path; no Dockerfile edits.
- Verification step added to acceptance: after `bun run package`, the produced tarball, when extracted, must contain `release/dist/public/assets/*.js.br`, `*.js.gz`, `*.css.br`, `*.css.gz`.
- Estimated tarball delta: assets section grows from ~590 KB to ~900 KB (br + gz siblings); negligible against the ~70 MB Bun binary.

## 10. Acceptance Criteria

1. `bun run build:frontend` produces `dist/public/assets/*.{js,css}` plus `*.br` and `*.gz` siblings.
2. Entry chunk (the file `index.html` references first) is under 200 KB raw; recharts ships in a separate chunk only loaded on `/usage`.
3. `bun run start` serves `/assets/*` with `Cache-Control: public, max-age=31536000, immutable` and `Content-Encoding: br` to a `Accept-Encoding: br, gzip` client.
4. `bun run start` serves `/` with `Cache-Control: no-cache` and a working ETag (304 on revisit).
5. Navigating to `/usage` after login triggers a separate network request for the recharts chunk (visible in DevTools Network tab).
6. `bun test` passes including the new `tests/static-spa.test.ts`.
7. `bun run package` succeeds; extracted tarball contains the precompressed siblings under `release/dist/public/assets/`.
8. `bun run typecheck` and `bun run lint` pass with no new warnings.

## 11. Out of Scope / Future Work

- Service worker for true offline support.
- Image asset pipeline.
- HTTP/2 push or 103 Early Hints.
- Splitting CSS per route.
