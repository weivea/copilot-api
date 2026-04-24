import { beforeEach, describe, expect, test } from "bun:test"

import {
  createAuthToken,
  deleteAuthToken,
  findAuthTokenByHash,
  getAuthTokenById,
  incrementLifetimeUsed,
  listAuthTokens,
  rotateAuthTokenSecret,
  setLifetimeUsed,
  touchLastUsed,
  updateAuthToken,
} from "../src/db/queries/auth-tokens"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
})

describe("auth-tokens queries", () => {
  test("create + find by hash + getById", async () => {
    const id = await createAuthToken({
      name: "alice",
      tokenHash: "h1",
      tokenPrefix: "cpk-aaaa...bbbb",
    })
    expect(id).toBeGreaterThan(0)
    const byHash = await findAuthTokenByHash("h1")
    expect(byHash?.name).toBe("alice")
    const byId = await getAuthTokenById(id)
    expect(byId?.id).toBe(id)
  })

  test("create with all fields", async () => {
    const id = await createAuthToken({
      name: "bob",
      tokenHash: "h2",
      tokenPrefix: "cpk-cccc...dddd",
      isAdmin: true,
      rpmLimit: 60,
      monthlyTokenLimit: 1000,
      lifetimeTokenLimit: 10_000,
      createdBy: 7,
    })
    const row = await getAuthTokenById(id)
    expect(row?.isAdmin).toBe(1)
    expect(row?.rpmLimit).toBe(60)
    expect(row?.createdBy).toBe(7)
  })

  test("list returns all", async () => {
    await createAuthToken({ name: "a", tokenHash: "ha", tokenPrefix: "p" })
    await createAuthToken({ name: "b", tokenHash: "hb", tokenPrefix: "p" })
    const rows = await listAuthTokens()
    expect(rows).toHaveLength(2)
  })

  test("update modifies given fields only", async () => {
    const id = await createAuthToken({
      name: "alice",
      tokenHash: "h",
      tokenPrefix: "p",
      monthlyTokenLimit: 100,
    })
    await updateAuthToken(id, { name: "alice2", rpmLimit: 30 })
    const row = await getAuthTokenById(id)
    expect(row?.name).toBe("alice2")
    expect(row?.rpmLimit).toBe(30)
    expect(row?.monthlyTokenLimit).toBe(100)
  })

  test("delete removes row", async () => {
    const id = await createAuthToken({
      name: "x",
      tokenHash: "hx",
      tokenPrefix: "p",
    })
    await deleteAuthToken(id)
    expect(await getAuthTokenById(id)).toBeUndefined()
  })

  test("rotateAuthTokenSecret replaces hash and prefix only", async () => {
    const id = await createAuthToken({
      name: "rot",
      tokenHash: "old-hash",
      tokenPrefix: "old-pre",
      rpmLimit: 7,
      monthlyTokenLimit: 100,
      lifetimeTokenLimit: 1000,
    })
    await incrementLifetimeUsed(id, 42)

    await rotateAuthTokenSecret(id, "new-hash", "new-pre")

    const row = await getAuthTokenById(id)
    if (!row) throw new Error("row missing")
    expect(row.tokenHash).toBe("new-hash")
    expect(row.tokenPrefix).toBe("new-pre")
    expect(row.name).toBe("rot")
    expect(row.rpmLimit).toBe(7)
    expect(row.monthlyTokenLimit).toBe(100)
    expect(row.lifetimeTokenLimit).toBe(1000)
    expect(row.lifetimeTokenUsed).toBe(42)
  })

  test("setLifetimeUsed and touchLastUsed", async () => {
    const id = await createAuthToken({
      name: "x",
      tokenHash: "hx",
      tokenPrefix: "p",
    })
    await setLifetimeUsed(id, 42)
    await touchLastUsed(id, 1234)
    const row = await getAuthTokenById(id)
    expect(row?.lifetimeTokenUsed).toBe(42)
    expect(row?.lastUsedAt).toBe(1234)
  })
})
