import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { staticSpa } from "~/lib/static-spa"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "static-spa-"))

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, "assets"), { recursive: true })
  fs.writeFileSync(path.join(ROOT, "index.html"), "<html>app</html>")
  fs.writeFileSync(
    path.join(ROOT, "assets", "index-abc123.js"),
    "console.log('raw')",
  )
  fs.writeFileSync(path.join(ROOT, "assets", "index-abc123.js.br"), "BR-BYTES")
  fs.writeFileSync(path.join(ROOT, "assets", "index-abc123.js.gz"), "GZ-BYTES")
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
    const etag = first.headers.get("etag")
    if (!etag) throw new Error("expected etag")
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
