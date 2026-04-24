import { beforeEach, describe, expect, test } from "bun:test"

import { createAuthToken } from "../src/db/queries/auth-tokens"
import {
  countRequestsSince,
  insertRequestLog,
  pruneOldLogs,
  recentLogs,
  sumTokensSince,
  timeseriesByBucket,
} from "../src/db/queries/request-logs"
import {
  appendUsageReset,
  latestUsageReset,
} from "../src/db/queries/usage-resets"
import { makeTestDb } from "./helpers/test-db"

beforeEach(() => {
  makeTestDb()
})

async function makeToken(): Promise<number> {
  return createAuthToken({ name: "x", tokenHash: "h", tokenPrefix: "p" })
}

describe("request-logs queries", () => {
  test("insert + countRequestsSince", async () => {
    const id = await makeToken()
    const now = Date.now()
    await insertRequestLog({
      authTokenId: id,
      timestamp: now - 1000,
      endpoint: "/v1/messages",
      statusCode: 200,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
    expect(await countRequestsSince(id, now - 5000)).toBe(1)
    expect(await countRequestsSince(id, now)).toBe(0)
  })

  test("sumTokensSince ignores null totals", async () => {
    const id = await makeToken()
    const now = Date.now()
    await insertRequestLog({
      authTokenId: id,
      timestamp: now - 100,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 50,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: now - 50,
      endpoint: "/x",
      statusCode: 500,
      totalTokens: null,
    })
    expect(await sumTokensSince(id, now - 1000)).toBe(50)
  })

  test("recentLogs respects limit and order desc", async () => {
    const id = await makeToken()
    for (let i = 0; i < 5; i++) {
      await insertRequestLog({
        authTokenId: id,
        timestamp: i,
        endpoint: "/x",
        statusCode: 200,
      })
    }
    const rows = await recentLogs({ tokenId: id, limit: 3 })
    expect(rows.map((r) => r.timestamp)).toEqual([4, 3, 2])
  })

  test("timeseriesByBucket groups by day", async () => {
    const id = await makeToken()
    const day = 86_400_000
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 10,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 5,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 10 + 100,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 7,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: day * 11,
      endpoint: "/x",
      statusCode: 200,
      totalTokens: 3,
    })
    const rows = await timeseriesByBucket({
      tokenId: id,
      from: 0,
      to: day * 12,
      bucket: "day",
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ requests: 2, tokens: 12 })
    expect(rows[1]).toMatchObject({ requests: 1, tokens: 3 })
  })

  test("pruneOldLogs deletes rows older than cutoff", async () => {
    const id = await makeToken()
    await insertRequestLog({
      authTokenId: id,
      timestamp: 1,
      endpoint: "/x",
      statusCode: 200,
    })
    await insertRequestLog({
      authTokenId: id,
      timestamp: 1000,
      endpoint: "/x",
      statusCode: 200,
    })
    await pruneOldLogs(500)
    expect(await countRequestsSince(id, 0)).toBe(1)
  })
})

describe("usage-resets queries", () => {
  test("appendUsageReset + latestUsageReset", async () => {
    const id = await makeToken()
    expect(await latestUsageReset(id, "monthly")).toBe(0)
    await appendUsageReset(id, "monthly", 100)
    await appendUsageReset(id, "monthly", 200)
    expect(await latestUsageReset(id, "monthly")).toBe(200)
    expect(await latestUsageReset(id, "lifetime")).toBe(0)
  })
})
