import { Database } from "bun:sqlite"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as migrator from "drizzle-orm/bun-sqlite/migrator"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  initDb,
  _setDbForTest,
  resolveMigrationsFolderFor,
} from "../src/db/client"
import { insertRequestLog } from "../src/db/queries/request-logs"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop()
    if (fn) fn()
  }
})

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-db-test-"))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, "test.db")
}

describe("initDb migration", () => {
  test("fresh file is migrated to current schema (cost_nano_aiu exists)", () => {
    const p = tmpDbPath()
    initDb(p)

    const sqlite = new Database(p)
    const cols = sqlite
      .query(`PRAGMA table_info(request_logs)`)
      .all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain("cost_nano_aiu")
    sqlite.close()
  })

  test("idempotent: calling initDb twice does not error or duplicate work", () => {
    const p = tmpDbPath()
    initDb(p)
    initDb(p) // Should be a no-op as far as migrations go.

    const sqlite = new Database(p)
    const rows = sqlite
      .query(`SELECT count(*) AS c FROM __drizzle_migrations`)
      .all() as Array<{ c: number }>
    // Two migrations: 0000 + 0001.
    expect(rows[0]?.c).toBe(2)
    sqlite.close()
  })

  test("inserts can carry cost_nano_aiu after migration", async () => {
    const p = tmpDbPath()
    const db = initDb(p)
    _setDbForTest(db)
    await insertRequestLog({
      authTokenId: null,
      timestamp: Date.now(),
      endpoint: "/v1/chat/completions",
      statusCode: 200,
      costNanoAiu: 1_500_000,
    })
    const sqlite = new Database(p)
    const row = sqlite
      .query(`SELECT cost_nano_aiu FROM request_logs LIMIT 1`)
      .get() as { cost_nano_aiu: number | null }
    expect(row.cost_nano_aiu).toBe(1_500_000)
    sqlite.close()
  })
})

describe("initDb fail-fast", () => {
  test("rethrows on migration failure", () => {
    const p = tmpDbPath()
    const spy = spyOn(migrator, "migrate").mockImplementation(() => {
      throw new Error("synthetic migration failure")
    })
    try {
      expect(() => initDb(p)).toThrow("synthetic migration failure")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("resolveMigrationsFolder (via initDb)", () => {
  test("works from an unrelated cwd (mirrors packaged binary path)", () => {
    // When Bun --compile produces a single-file binary, `import.meta.dir`
    // resolves to /$bunfs/root/ (the embedded virtual fs), so initDb must
    // be able to find drizzle/ via process.execPath or cwd instead. Simulate
    // a hostile cwd by chdir'ing into /tmp before calling initDb. The repo's
    // own drizzle/ folder is reachable via `<import.meta.dir>/../../drizzle`,
    // which is the dev-fallback candidate (3rd in the list), so this also
    // proves the multi-candidate resolver doesn't bail on the first miss.
    const originalCwd = process.cwd()
    const isolatedCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-api-cwd-test-"),
    )
    cleanup.push(() => {
      process.chdir(originalCwd)
      fs.rmSync(isolatedCwd, { recursive: true, force: true })
    })
    process.chdir(isolatedCwd)

    const p = tmpDbPath()
    expect(() => initDb(p)).not.toThrow()

    const sqlite = new Database(p)
    const cols = sqlite
      .query(`PRAGMA table_info(request_logs)`)
      .all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain("cost_nano_aiu")
    sqlite.close()
  })
})

describe("resolveMigrationsFolderFor (pure)", () => {
  test("prefers execPath-relative candidate when packaged layout matches", () => {
    // Simulates the packaged binary case:
    //   /opt/copilot-api/release/bin/copilot-api  ← execPath
    //   /opt/copilot-api/release/drizzle/...       ← what we want to find
    // metaDir is the /$bunfs/root/ virtual fs (everything under it is junk).
    // cwd is some random place (doesn't matter for this case).
    const seen: Array<string> = []
    const result = resolveMigrationsFolderFor({
      execPath: "/opt/copilot-api/release/bin/copilot-api",
      cwd: "/var/run/systemd",
      metaDir: "/$bunfs/root",
      exists: (p) => {
        seen.push(p)
        return p === "/opt/copilot-api/release/drizzle/meta/_journal.json"
      },
    })
    expect(result).toBe("/opt/copilot-api/release/drizzle")
    // Probed execPath candidate first (and stopped there).
    expect(seen[0]).toBe("/opt/copilot-api/release/drizzle/meta/_journal.json")
    expect(seen).toHaveLength(1)
  })

  test("falls back to cwd-relative when execPath candidate is missing", () => {
    const result = resolveMigrationsFolderFor({
      execPath: "/$bunfs/root/copilot-api",
      cwd: "/opt/copilot-api/release",
      metaDir: "/$bunfs/root",
      exists: (p) =>
        p === "/opt/copilot-api/release/drizzle/meta/_journal.json",
    })
    expect(result).toBe("/opt/copilot-api/release/drizzle")
  })

  test("falls back to metaDir-relative as last resort (dev)", () => {
    const result = resolveMigrationsFolderFor({
      execPath: "/some/bun",
      cwd: "/tmp/random",
      metaDir: "/repo/src/db",
      exists: (p) => p === "/repo/drizzle/meta/_journal.json",
    })
    expect(result).toBe("/repo/drizzle")
  })

  test("returns the first candidate when nothing exists (so the error names the most-likely path)", () => {
    const result = resolveMigrationsFolderFor({
      execPath: "/opt/copilot-api/release/bin/copilot-api",
      cwd: "/var/run/systemd",
      metaDir: "/$bunfs/root",
      exists: () => false,
    })
    expect(result).toBe("/opt/copilot-api/release/drizzle")
  })

  test("skips execPath candidate when execPath is undefined", () => {
    const result = resolveMigrationsFolderFor({
      cwd: "/opt/copilot-api/release",
      metaDir: "/$bunfs/root",
      exists: (p) =>
        p === "/opt/copilot-api/release/drizzle/meta/_journal.json",
    })
    expect(result).toBe("/opt/copilot-api/release/drizzle")
  })
})
