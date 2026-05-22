import { Database } from "bun:sqlite"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as migrator from "drizzle-orm/bun-sqlite/migrator"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { initDb, _setDbForTest } from "../src/db/client"
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
