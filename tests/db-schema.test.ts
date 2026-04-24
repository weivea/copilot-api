import { describe, expect, test } from "bun:test"

import { authTokens } from "../src/db/schema"
import { makeTestDb } from "./helpers/test-db"

describe("db schema", () => {
  test("can insert and select a token row", () => {
    const db = makeTestDb()
    db.insert(authTokens)
      .values({
        name: "alice",
        tokenHash: "h",
        tokenPrefix: "cpk-aaaa...bbbb",
        createdAt: Date.now(),
      })
      .run()
    const rows = db.select().from(authTokens).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe("alice")
    expect(rows[0]?.isAdmin).toBe(0)
    expect(rows[0]?.lifetimeTokenUsed).toBe(0)
  })
})
