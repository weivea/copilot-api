import { describe, expect, test } from "bun:test"

import { suggestBucket } from "./bucket"

describe("suggestBucket", () => {
  test("range <=2 days → hour", () => {
    expect(suggestBucket(0, 2 * 86_400_000)).toBe("hour")
  })
  test("range <=60 days → day", () => {
    expect(suggestBucket(0, 30 * 86_400_000)).toBe("day")
  })
  test("range <=365 days → week", () => {
    expect(suggestBucket(0, 200 * 86_400_000)).toBe("week")
  })
  test("range >365 days → month", () => {
    expect(suggestBucket(0, 800 * 86_400_000)).toBe("month")
  })
})
