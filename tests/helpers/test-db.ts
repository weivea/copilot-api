import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"

import { _setDbForTest } from "../../src/db/client"
import * as schema from "../../src/db/schema"

export function makeTestDb(): BunSQLiteDatabase<typeof schema> {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: "drizzle" })
  _setDbForTest(db)
  return db
}
