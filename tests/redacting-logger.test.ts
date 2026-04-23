import { describe, expect, test } from "bun:test"

import { redactKeyParam } from "../src/lib/redacting-logger"

describe("redactKeyParam", () => {
  test("removes ?key=...", () => {
    expect(redactKeyParam("/foo?key=cpk-secret&x=1")).toBe(
      "/foo?key=REDACTED&x=1",
    )
  })
  test("untouched without key", () => {
    expect(redactKeyParam("/foo?x=1")).toBe("/foo?x=1")
  })
  test("handles trailing key", () => {
    expect(redactKeyParam("/?key=abc")).toBe("/?key=REDACTED")
  })
})
