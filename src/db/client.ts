import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import fs from "node:fs"
import path from "node:path"

import * as schema from "./schema"

let db: BunSQLiteDatabase<typeof schema> | undefined

export function initDb(dbPath: string): BunSQLiteDatabase<typeof schema> {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.exec("PRAGMA journal_mode = WAL;")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  try {
    fs.chmodSync(dbPath, 0o600)
  } catch {
    /* ignore on systems that don't support chmod */
  }
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: "drizzle" })
  return db
}

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (!db) throw new Error("DB not initialized; call initDb first")
  return db
}

// Test helper: replace the active DB (e.g. in-memory) without re-running migrations
export function _setDbForTest(next: BunSQLiteDatabase<typeof schema>): void {
  db = next
}
