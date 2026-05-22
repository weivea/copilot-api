import { describe, expect, mock, test } from "bun:test"
import consola from "consola"

import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "../src/lib/copilot-info-messages"

describe("captureInfoMessages", () => {
  test("undefined source returns undefined and does not log", () => {
    const warn = mock(() => {})
    const orig = consola.warn
    consola.warn = warn as never

    const out = captureInfoMessages(undefined, { endpoint: "/v1/x" })
    expect(out).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()

    consola.warn = orig
  })

  test("empty array returns undefined and does not log", () => {
    const warn = mock(() => {})
    const orig = consola.warn
    consola.warn = warn as never

    const out = captureInfoMessages(
      { copilot_info_messages: [] },
      { endpoint: "/v1/x" },
    )
    expect(out).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()

    consola.warn = orig
  })

  test("known code logs via warn and returns the array", () => {
    const warn = mock(() => {})
    const orig = consola.warn
    consola.warn = warn as never

    const messages = [
      { code: "model_pending_deprecation", message: "GPT-5.2 deprecates soon" },
    ]
    const out = captureInfoMessages(
      { copilot_info_messages: messages },
      { endpoint: "/v1/chat/completions", model: "gpt-5.2" },
    )

    expect(out).toEqual(messages)
    expect(warn).toHaveBeenCalledTimes(1)
    const arg = warn.mock.calls[0][0] as string
    expect(arg).toContain("model_pending_deprecation")
    expect(arg).toContain("/v1/chat/completions")
    expect(arg).toContain("gpt-5.2")

    consola.warn = orig
  })

  test("unknown code logs via info, not warn", () => {
    const warn = mock(() => {})
    const info = mock(() => {})
    const origW = consola.warn
    const origI = consola.info
    consola.warn = warn as never
    consola.info = info as never

    captureInfoMessages(
      { copilot_info_messages: [{ code: "future_unknown", message: "x" }] },
      { endpoint: "/v1/x" },
    )

    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)

    consola.warn = origW
    consola.info = origI
  })

  test("idempotent: same source object logged only once", () => {
    const warn = mock(() => {})
    const orig = consola.warn
    consola.warn = warn as never

    const src = {
      copilot_info_messages: [
        { code: "model_pending_deprecation", message: "x" },
      ],
    }
    captureInfoMessages(src, { endpoint: "/v1/x" })
    captureInfoMessages(src, { endpoint: "/v1/x" })

    expect(warn).toHaveBeenCalledTimes(1)

    consola.warn = orig
  })
})

describe("pickCostNanoAiu", () => {
  test("undefined → null", () => {
    expect(pickCostNanoAiu(undefined)).toBeNull()
  })
  test("missing copilot_usage → null", () => {
    expect(pickCostNanoAiu({})).toBeNull()
  })
  test("zero → null (treated as no-data)", () => {
    expect(pickCostNanoAiu({ copilot_usage: { total_nano_aiu: 0 } })).toBeNull()
  })
  test("positive number returned as-is", () => {
    expect(
      pickCostNanoAiu({ copilot_usage: { total_nano_aiu: 1_500_000 } }),
    ).toBe(1_500_000)
  })
  test("non-number ignored", () => {
    expect(
      pickCostNanoAiu({
        copilot_usage: { total_nano_aiu: "1500000" as unknown as number },
      }),
    ).toBeNull()
  })
})
