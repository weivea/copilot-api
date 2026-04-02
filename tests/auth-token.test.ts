import { describe, test, expect } from "bun:test"
import fs from "node:fs/promises"

import {
  generateAuthToken,
  loadAuthToken,
  saveAuthToken,
} from "../src/lib/auth-token"
import { PATHS } from "../src/lib/paths"

describe("generateAuthToken", () => {
  test("should return a string starting with cpk-", () => {
    const token = generateAuthToken()
    expect(token.startsWith("cpk-")).toBe(true)
  })

  test("should return a 68-character token (cpk- + 64 hex chars)", () => {
    const token = generateAuthToken()
    expect(token).toHaveLength(68)
  })

  test("should generate unique tokens each time", () => {
    const token1 = generateAuthToken()
    const token2 = generateAuthToken()
    expect(token1).not.toBe(token2)
  })

  test("should only contain hex characters after prefix", () => {
    const token = generateAuthToken()
    const hex = token.slice(4)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("saveAuthToken and loadAuthToken", () => {
  test("should save and load token from disk", async () => {
    const token = generateAuthToken()
    await saveAuthToken(token)

    const loaded = await loadAuthToken()
    expect(loaded).toBe(token)

    // Cleanup
    await fs.writeFile(PATHS.AUTH_TOKEN_PATH, "")
  })

  test("should return undefined when token file is empty", async () => {
    await fs.writeFile(PATHS.AUTH_TOKEN_PATH, "")
    const loaded = await loadAuthToken()
    expect(loaded).toBeUndefined()
  })
})
