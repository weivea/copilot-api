import { beforeEach, describe, expect, test } from "bun:test"

import {
  createSession,
  deleteSession,
  deleteSessionsForToken,
  expireOldSessions,
  getSessionById,
} from "../src/db/queries/sessions"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
})

describe("sessions queries", () => {
  test("create + get + delete", async () => {
    const id = await createSession({
      authTokenId: 7,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    const row = await getSessionById(id)
    expect(row?.authTokenId).toBe(7)
    expect(row?.isSuperAdmin).toBe(0)
    expect(row?.expiresAt).toBeGreaterThan(Date.now())
    await deleteSession(id)
    expect(await getSessionById(id)).toBeUndefined()
  })

  test("super admin session has null tokenId and flag set", async () => {
    const id = await createSession({
      authTokenId: null,
      isSuperAdmin: true,
      ttlMs: 60_000,
    })
    const row = await getSessionById(id)
    expect(row?.authTokenId).toBeNull()
    expect(row?.isSuperAdmin).toBe(1)
  })

  test("deleteSessionsForToken cascades", async () => {
    const a = await createSession({
      authTokenId: 9,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    const b = await createSession({
      authTokenId: 9,
      isSuperAdmin: false,
      ttlMs: 60_000,
    })
    await deleteSessionsForToken(9)
    expect(await getSessionById(a)).toBeUndefined()
    expect(await getSessionById(b)).toBeUndefined()
  })

  test("expireOldSessions removes expired", async () => {
    const id = await createSession({
      authTokenId: 1,
      isSuperAdmin: false,
      ttlMs: -1,
    })
    await expireOldSessions()
    expect(await getSessionById(id)).toBeUndefined()
  })
})
