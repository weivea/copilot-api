import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesContentPart,
  ResponsesFunctionCallOutput,
  ResponsesInputItem,
  ResponsesMessageOutput,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesTool,
} from "~/services/copilot/create-responses"

export function chatRequestToResponses(
  chat: ChatCompletionsPayload,
): ResponsesPayload {
  const systemTexts: Array<string> = []
  const input: Array<ResponsesInputItem> = []

  for (const msg of chat.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = stringifyContent(msg.content)
      if (text) systemTexts.push(text)
      continue
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: stringifyContent(msg.content),
      })
      continue
    }

    if (
      msg.role === "assistant"
      && msg.tool_calls
      && msg.tool_calls.length > 0
    ) {
      // If the assistant turn carries text alongside tool_calls, emit the text
      // first as a normal message item, then each tool_call as its own item.
      const text = stringifyContent(msg.content)
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "input_text", text }],
        })
      }
      for (const call of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
      }
      continue
    }

    input.push({
      type: "message",
      role: msg.role,
      content: messageContentToResponses(msg.content),
    })
  }

  const out: ResponsesPayload = {
    model: chat.model,
    input,
    store: false,
  }

  if (systemTexts.length > 0) out.instructions = systemTexts.join("\n\n")
  if (chat.stream != null) out.stream = chat.stream
  if (chat.temperature != null) out.temperature = chat.temperature
  if (chat.top_p != null) out.top_p = chat.top_p
  if (chat.stop != null) out.stop = chat.stop
  if (chat.max_tokens != null) out.max_output_tokens = chat.max_tokens
  if (chat.user != null) out.user = chat.user
  if (chat.tool_choice != null)
    out.tool_choice = translateToolChoice(chat.tool_choice)
  if (chat.tools != null) out.tools = chat.tools.map(translateTool)

  // Optional extension: clients (Claude Code etc.) sometimes forward
  // reasoning_effort. Pass it through as Responses' reasoning.effort.
  const maybeReasoning = (chat as { reasoning_effort?: string })
    .reasoning_effort
  if (
    maybeReasoning === "low"
    || maybeReasoning === "medium"
    || maybeReasoning === "high"
  ) {
    out.reasoning = { effort: maybeReasoning }
  }

  return out
}

function stringifyContent(content: Message["content"]): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("")
}

function messageContentToResponses(
  content: Message["content"],
): Array<ResponsesContentPart> {
  if (content == null) return []
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }]
  }
  return content
    .map(translatePart)
    .filter(Boolean) as Array<ResponsesContentPart>
}

function translatePart(part: ContentPart): ResponsesContentPart | null {
  if (part.type === "text") return { type: "input_text", text: part.text }
  if (part.type === "image_url") {
    return { type: "input_image", image_url: part.image_url.url }
  }
  return null
}

function translateTool(tool: Tool): ResponsesTool {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }
}

function translateToolChoice(
  choice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): NonNullable<ResponsesPayload["tool_choice"]> {
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.function.name }
}

export function responsesToChatResponse(
  resp: ResponsesResponse,
): ChatCompletionResponse {
  const messageParts: Array<string> = []
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  for (const item of resp.output) {
    if (item.type === "message") {
      const m = item as ResponsesMessageOutput
      for (const part of m.content) {
        if (part.type === "output_text") messageParts.push(part.text)
      }
    } else if (item.type === "function_call") {
      const fc = item as ResponsesFunctionCallOutput
      toolCalls.push({
        id: fc.call_id,
        type: "function",
        function: { name: fc.name, arguments: fc.arguments },
      })
    }
    // reasoning items intentionally dropped from chat-shaped output for now
  }

  const finishReason: ChatCompletionResponse["choices"][number]["finish_reason"] =
    toolCalls.length > 0
      ? "tool_calls"
      : resp.status === "incomplete"
        ? "length"
        : resp.status === "failed"
          ? "content_filter"
          : "stop"

  const content = messageParts.length > 0 ? messageParts.join("") : null

  return {
    id: `chatcmpl-${resp.id}`,
    object: "chat.completion",
    created: resp.created_at,
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.input_tokens,
          completion_tokens: resp.usage.output_tokens,
          total_tokens: resp.usage.total_tokens,
          ...(resp.usage.input_tokens_details
            ? {
                prompt_tokens_details: {
                  cached_tokens: resp.usage.input_tokens_details.cached_tokens ?? 0,
                },
              }
            : {}),
        }
      : undefined,
  }
}
