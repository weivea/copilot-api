import { describe, expect, test } from "bun:test"

import type { AnthropicStreamState } from "~/routes/messages/anthropic-types"

import { buildCopilotInfoEvent } from "~/routes/messages/stream-translation"

/**
 * The streaming handler in src/routes/messages/handler.ts is responsible for:
 *   1. Calling translateChunkToAnthropicEvents per chunk
 *   2. Caching copilot_info_messages it observes on chunks
 *   3. Emitting a synthesized `copilot_info` event between `content_block_stop`
 *      and `message_delta` during finalization.
 *
 * Steps 1+3 are tested at the handler level in tests/usage-recorder.test.ts
 * and via integration. Here we lock down step 2 — the helper that
 * synthesizes the event payload given an AnthropicStreamState.
 */

describe("buildCopilotInfoEvent", () => {
  test("returns null when no messages cached", () => {
    const state: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    expect(buildCopilotInfoEvent(state)).toBeNull()
  })

  test("emits a copilot_info event payload when messages cached", () => {
    const state: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      copilotInfoMessages: [
        { code: "model_pending_deprecation", message: "x" },
      ],
    }
    const event = buildCopilotInfoEvent(state)
    expect(event).toEqual({
      type: "copilot_info",
      messages: [{ code: "model_pending_deprecation", message: "x" }],
    })
  })
})
