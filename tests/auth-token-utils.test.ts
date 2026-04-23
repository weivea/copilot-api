import { describe, expect, test } from "bun:test"

import {
  generateToken,
  hashToken,
  prefixOf,
} from "../src/lib/auth-token-utils"

describe("auth-token-utils", () => {
  test("generateToken returns cpk-<64 hex>", () => {
    const t = generateToken()
    expect(t).toMatch(/^cpk-[0-9a-f]{64}$/)
  })

  test("hashToken returns deterministic 64-char hex", () => {
    const a = hashToken("cpk-abc")
    const b = hashToken("cpk-abc")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test("hashToken differs for different inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"))
  })

  test("prefixOf returns first 8 + ... + last 4 of suffix", () => {
    // cpk- + 64 hex = 68 chars
    const tok = "cpk-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"
    expect(prefixOf(tok)).toBe("cpk-0123...abcd")
  })
})
