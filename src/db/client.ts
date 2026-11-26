import { Database } from "bun:sqlite"
import consola from "consola"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import fs from "node:fs"
import path from "node:path"

import { startOfCurrentMonthMs } from "~/lib/usage-normalizer"

import * as schema from "./schema"

let db: BunSQLiteDatabase<typeof schema> | undefined

export function backfillMonthlyTokenUsage(
  sqlite: Database,
  monthStart = startOfCurrentMonthMs(),
): void {
  sqlite
    .prepare(
      `
      UPDATE auth_tokens
      SET
        monthly_window_start = max(
          ?1,
          coalesce(
            (
              SELECT max(reset_at)
              FROM usage_resets
              WHERE usage_resets.auth_token_id = auth_tokens.id
                AND usage_resets.kind = 'monthly'
            ),
            0
          )
        ),
        monthly_token_used = coalesce(
          (
            SELECT sum(coalesce(billable_tokens, total_tokens, 0))
            FROM request_logs
            WHERE request_logs.auth_token_id = auth_tokens.id
              AND request_logs.endpoint != '/v1/messages/count_tokens'
              AND request_logs.timestamp >= max(
                ?1,
                coalesce(
                  (
                    SELECT max(reset_at)
                    FROM usage_resets
                    WHERE usage_resets.auth_token_id = auth_tokens.id
                      AND usage_resets.kind = 'monthly'
                  ),
                  0
                )
              )
          ),
          0
        )
      WHERE monthly_window_start = 0
        AND (
          EXISTS (SELECT 1 FROM request_logs WHERE request_logs.auth_token_id = auth_tokens.id)
          OR EXISTS (
            SELECT 1 FROM usage_resets
            WHERE usage_resets.auth_token_id = auth_tokens.id
              AND usage_resets.kind = 'monthly'
          )
        )
      `,
    )
    .run(monthStart)
}

export function initDb(dbPath: string): BunSQLiteDatabase<typeof schema> {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.run("PRAGMA journal_mode = WAL;")
  sqlite.run("PRAGMA foreign_keys = ON;")
  try {
    fs.chmodSync(dbPath, 0o600)
  } catch {
    /* ignore on systems that don't support chmod */
  }
  db = drizzle(sqlite, { schema })

  try {
    migrate(db, { migrationsFolder: resolveMigrationsFolder() })
    backfillMonthlyTokenUsage(sqlite)
  } catch (err) {
    consola.fatal("Database migration failed; refusing to start.", err)
    throw err
  }

  return db
}

/**
 * Find the drizzle migrations folder regardless of how the binary was
 * launched. Validates each candidate by probing for `meta/_journal.json`
 * so we don't return a path that exists-but-isn't-a-migrations-folder.
 *
 * Why we can't just use `import.meta.dir`: when Bun `--compile`s a
 * single-file binary, `import.meta.dir` resolves to `/$bunfs/root/`
 * (the embedded virtual fs), NOT the real on-disk location of the
 * binary. The drizzle/ folder is copied next to `bin/` in the release
 * tarball, so we have to derive paths from `process.execPath` or
 * `process.cwd()` instead.
 *
 * Candidate order:
 *   1. `<execPath dir>/../drizzle`  — packaged binary
 *      (release/bin/copilot-api → release/drizzle).
 *   2. `<cwd>/drizzle`              — systemd WorkingDirectory=release/
 *      and `bun run dev` from repo root both land here.
 *   3. `<import.meta.dir>/../../drizzle` — dev fallback when running
 *      via `bun run src/main.ts` from an unusual cwd.
 *
 * Exported for testability. `initDb` always calls it with the live
 * process values; tests inject synthetic ones.
 */
export interface MigrationsFolderLocator {
  execPath?: string
  cwd: string
  metaDir: string
  exists?: (p: string) => boolean
}

export function resolveMigrationsFolderFor(
  loc: MigrationsFolderLocator,
): string {
  const exists = loc.exists ?? fs.existsSync
  const candidates: Array<string> = [
    ...(loc.execPath ?
      [path.join(path.dirname(loc.execPath), "..", "drizzle")]
    : []),
    path.join(loc.cwd, "drizzle"),
    path.join(loc.metaDir, "..", "..", "drizzle"),
  ]

  for (const candidate of candidates) {
    if (exists(path.join(candidate, "meta", "_journal.json"))) {
      return candidate
    }
  }

  // Nothing matched. Return the first candidate so the resulting error
  // message points at the most likely intended location.
  return candidates[0] ?? path.join(loc.metaDir, "drizzle")
}

function resolveMigrationsFolder(): string {
  return resolveMigrationsFolderFor({
    execPath: process.execPath,
    cwd: process.cwd(),
    metaDir: import.meta.dir,
  })
}

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (!db) throw new Error("DB not initialized; call initDb first")
  return db
}

// Test helper: replace the active DB (e.g. in-memory) without re-running migrations
export function _setDbForTest(next: BunSQLiteDatabase<typeof schema>): void {
  db = next
}
