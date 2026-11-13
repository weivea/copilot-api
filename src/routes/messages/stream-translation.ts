import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicCopilotInfoEvent,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { parseToolArguments, translateUsage } from "./non-stream-translation"

function closeTextBlock(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
) {
  if (!state.contentBlockOpen) return
  events.push({ type: "content_block_stop", index: state.contentBlockIndex })
  state.contentBlockIndex++
  state.contentBlockOpen = false
}

function translateToolDeltas(
  calls: NonNullable<
    ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]
  >,
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
) {
  for (const call of calls) {
    const tool = (state.toolCalls[call.index] ??= {
      id: "",
      name: "",
      anthropicBlockIndex: -1,
      arguments: "",
    })
    if (call.id) tool.id = call.id
    if (call.function?.name) {
      if (tool.open)
        throw new Error(
          "Upstream changed a tool name after starting its arguments",
        )
      tool.name += call.function.name
    }
    const argumentsDelta = call.function?.arguments ?? ""
    tool.arguments = (tool.arguments ?? "") + argumentsDelta
    if (!tool.open && tool.arguments && tool.id && tool.name) {
      closeTextBlock(state, events)
      tool.anthropicBlockIndex = state.contentBlockIndex++
      tool.open = true
      events.push(
        {
          type: "content_block_start",
          index: tool.anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: tool.anthropicBlockIndex,
          delta: { type: "input_json_delta", partial_json: tool.arguments },
        },
      )
    } else if (tool.open && argumentsDelta) {
      events.push({
        type: "content_block_delta",
        index: tool.anthropicBlockIndex,
        delta: { type: "input_json_delta", partial_json: argumentsDelta },
      })
    }
  }
}

function closeToolBlocks(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
) {
  for (const [index, tool] of Object.entries(state.toolCalls)) {
    if (!tool.open && tool.id && tool.name && !tool.arguments) {
      translateToolDeltas(
        [{ index: Number(index), function: { arguments: "{}" } }],
        state,
        events,
      )
    }
    if (!tool.open) throw new Error("Upstream returned an incomplete tool call")
    if (state.finishReason !== "length")
      parseToolArguments(tool.arguments ?? "")
    events.push({ type: "content_block_stop", index: tool.anthropicBlockIndex })
    tool.open = false
  }
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { ...translateUsage(chunk.usage), output_tokens: 0 },
      },
    })
    state.messageStartSent = true
  }

  if (delta.refusal) state.refusal = true
  const text = delta.content ?? delta.refusal
  if (text) {
    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text,
      },
    })
  }

  if (delta.tool_calls) {
    translateToolDeltas(delta.tool_calls, state, events)
  }

  if (choice.finish_reason) {
    // Final events wait for trailing usage and a successful upstream completion.
    state.finishReason = state.refusal ? "content_filter" : choice.finish_reason
    if (
      state.finishReason === "stop"
      && Object.keys(state.toolCalls).length > 0
    )
      state.finishReason = "tool_calls"
    closeTextBlock(state, events)
    closeToolBlocks(state, events)
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}

/**
 * Build the synthesized `copilot_info` event payload from cached upstream
 * info_messages. Returns null when there is nothing to send.
 */
export function buildCopilotInfoEvent(
  state: AnthropicStreamState,
): AnthropicCopilotInfoEvent | null {
  if (!state.copilotInfoMessages?.length) return null
  return {
    type: "copilot_info",
    messages: state.copilotInfoMessages,
  }
}
