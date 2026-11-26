import { describe, expect, test } from "bun:test"

import {
  getEffectiveMonthlyUsed,
  normalizeAnthropicUsage,
  normalizeChatUsage,
  normalizeResponsesUsage,
  normalizeSimpleUsage,
} from "../src/lib/usage-normalizer"

describe("usage-normalizer", () => {
  test("Gemini / Chat with cache + reasoning does not double-add sub-counts", () => {
    const u = normalizeChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 450,
      total_tokens: 1450,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 300 },
    })
    expect(u).toEqual({
      promptTokens: 1000,
      cachedTokens: 800,
      cacheCreationTokens: null,
      completionTokens: 450,
      reasoningTokens: 300,
      totalTokens: 1450,
      billableTokens: 1450,
      usageComplete: true,
    })
  })

  test("Gemini / Chat without cache preserves explicit 0 vs missing null", () => {
    const withZero = normalizeChatUsage({
      prompt_tokens: 500,
      completion_tokens: 0,
      total_tokens: 500,
      prompt_tokens_details: { cached_tokens: 0 },
    })
    expect(withZero.cachedTokens).toBe(0)
    expect(withZero.completionTokens).toBe(0)
    expect(withZero.cacheCreationTokens).toBeNull()
    expect(withZero.reasoningTokens).toBeNull()

    const withoutDetails = normalizeChatUsage({
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600,
    })
    expect(withoutDetails.cachedTokens).toBeNull()
    expect(withoutDetails.reasoningTokens).toBeNull()
  })

  test("Claude native and Chat-translated usages produce identical normalized totals", () => {
    const native = normalizeAnthropicUsage({
      input_tokens: 200,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 150,
      output_tokens: 90,
    })
    const translated = normalizeChatUsage({
      prompt_tokens: 1150,
      completion_tokens: 90,
      total_tokens: 1240,
      prompt_tokens_details: {
        cached_tokens: 800,
        cache_creation_input_tokens: 150,
      },
    })
    expect(native).toEqual(translated)
    expect(native.promptTokens).toBe(1150)
    expect(native.totalTokens).toBe(1240)
    expect(native.billableTokens).toBe(1240)
  })

  test("Responses usage preserves cached and reasoning sub-counts without double-adding", () => {
    const u = normalizeResponsesUsage({
      input_tokens: 400,
      output_tokens: 120,
      total_tokens: 520,
      input_tokens_details: { cached_tokens: 300 },
      output_tokens_details: { reasoning_tokens: 80 },
    })
    expect(u).toEqual({
      promptTokens: 400,
      cachedTokens: 300,
      cacheCreationTokens: null,
      completionTokens: 120,
      reasoningTokens: 80,
      totalTokens: 520,
      billableTokens: 520,
      usageComplete: true,
    })
  })

  test("Incomplete / partial usage keeps missing fields as null instead of 0 or guessing total", () => {
    const partial = normalizeAnthropicUsage(
      { input_tokens: 120, cache_read_input_tokens: 30 },
      { usageComplete: false },
    )
    expect(partial).toEqual({
      promptTokens: 150,
      cachedTokens: 30,
      cacheCreationTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      billableTokens: null,
      usageComplete: false,
    })

    const missing = normalizeSimpleUsage(undefined, { usageComplete: false })
    expect(missing.totalTokens).toBeNull()
    expect(missing.billableTokens).toBeNull()
    expect(missing.usageComplete).toBe(false)

    // Even if caller passes usageComplete: true, a billable record missing totalTokens MUST be incomplete
    const partialWithTrueFlag = normalizeChatUsage(
      { prompt_tokens: 100 },
      { usageComplete: true },
    )
    expect(partialWithTrueFlag.totalTokens).toBeNull()
    expect(partialWithTrueFlag.billableTokens).toBeNull()
    expect(partialWithTrueFlag.usageComplete).toBe(false)

    const emptyWithTrueFlag = normalizeAnthropicUsage(undefined, {
      usageComplete: true,
    })
    expect(emptyWithTrueFlag.usageComplete).toBe(false)
  })

  test("getEffectiveMonthlyUsed lazily rolls over across month boundary and respects mid-month reset", () => {
    const monthStart = new Date(2026, 3, 1, 0, 0, 0, 0).getTime()
    // Previous month window -> rolls over to 0
    expect(
      getEffectiveMonthlyUsed(
        { monthlyTokenUsed: 950, monthlyWindowStart: monthStart - 1 },
        monthStart,
      ),
    ).toBe(0)
    // Current month window -> returns stored usage
    expect(
      getEffectiveMonthlyUsed(
        { monthlyTokenUsed: 420, monthlyWindowStart: monthStart },
        monthStart,
      ),
    ).toBe(420)
    // Mid-month reset (monthlyWindowStart = resetTs > monthStart) -> returns post-reset usage
    expect(
      getEffectiveMonthlyUsed(
        { monthlyTokenUsed: 75, monthlyWindowStart: monthStart + 86_400_000 },
        monthStart,
      ),
    ).toBe(75)
  })
})
