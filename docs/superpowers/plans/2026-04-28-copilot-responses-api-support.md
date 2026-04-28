# Copilot `/responses` API Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public `/v1/responses` endpoint and transparent fallback so `/chat/completions` and `/v1/messages` clients can use Copilot models that are only exposed via `/responses` (e.g. `gpt-5.5`).

**Architecture:** A new `create-responses.ts` upstream service is added alongside `create-chat-completions.ts`. A `responses-routing` module keeps an in-memory whitelist (auto-built from `/models`) plus a runtime cache of models that returned `unsupported_api_for_model`. A bidirectional `chat-to-responses` translation module converts between protocols so existing chat-shaped paths can transparently call `/responses`. A new `/v1/responses` route forwards directly to upstream without translation.

**Tech Stack:** Bun · Hono · TypeScript (strict) · zod · consola · `fetch-event-stream`

**Spec:** `docs/superpowers/specs/2026-04-28-copilot-responses-api-support-design.md`

---

## File Structure

**New files:**
- `src/services/copilot/create-responses.ts` — upstream `/responses` HTTP call (streaming + non-streaming)
- `src/lib/responses-routing.ts` — whitelist + runtime cache + `shouldUseResponsesEndpoint`
- `src/lib/translation/chat-to-responses.ts` — translation in three directions (request, non-stream response, stream)
- `src/routes/responses/route.ts` — Hono router
- `src/routes/responses/handler.ts` — handler that forwards directly to upstream
- `tests/responses-routing.test.ts`
- `tests/translation-chat-to-responses.test.ts`
- `tests/responses-endpoint.test.ts`
- `tests/chat-to-responses-fallback.test.ts`

**Modified files:**
- `src/services/copilot/create-chat-completions.ts` — pre-call routing check + `unsupported_api_for_model` catch-and-retry via responses
- `src/services/copilot/get-models.ts` — call `rebuildWhitelistFromModels` after fetching
- `src/server.ts` — mount `/v1/responses` and add `requireCopilotReady` for it
- `README.md` — new "Responses API" section

**Out of scope for this plan (optional, deferred):** the admin Models page badge for `routedViaResponses`. We can add it once the core path is proven.

---

## Task 0: Pre-flight — capture real Copilot `/models` and `/responses` payloads

**Why:** The whole design assumes (a) `gpt-5.5` is detectable from `/models` capabilities and (b) Copilot `/responses` follows the OpenAI public protocol. We must verify both before writing code that depends on them.

**Files:** none committed (working notes only)

- [ ] **Step 1: Start dev server and dump `/models` for `gpt-5.5`**

```bash
bun run dev &
DEV_PID=$!
sleep 3
# Hit the local proxy — auth optional via dev mode; if blocked use direct upstream:
curl -s http://localhost:4141/v1/models | jq '.data[] | select(.id == "gpt-5.5")'
kill $DEV_PID
```

Record the full JSON object. Note in particular:
- `capabilities.type`
- `capabilities.supports.*`
- `model_picker_enabled`
- `policy.state`
- `preview`

- [ ] **Step 2: Capture a minimal real `/responses` request**

Using a captured Copilot token (look in `~/.local/share/copilot-api/` or `state.copilotToken` after auth), send:

```bash
curl -sS https://api.githubcopilot.com/responses \
  -H "Authorization: Bearer $COPILOT_TOKEN" \
  -H "content-type: application/json" \
  -H "copilot-integration-id: vscode-chat" \
  -H "editor-version: vscode/1.99.0" \
  -H "editor-plugin-version: copilot-chat/0.26.7" \
  -H "user-agent: GitHubCopilotChat/0.26.7" \
  -H "openai-intent: conversation-panel" \
  -H "x-github-api-version: 2025-04-01" \
  -d '{"model":"gpt-5.5","input":"say hi","stream":false,"store":false}' \
  | tee /tmp/responses-nonstream.json
```

Then a streaming variant with `"stream":true`, save raw SSE to `/tmp/responses-stream.txt`.

- [ ] **Step 3: Reconcile design vs reality**

Compare to spec §3 translation tables. If field names / event names differ from the OpenAI public protocol, **stop and update the spec doc** before proceeding. If they match, append a one-paragraph note to the spec saying "verified against Copilot upstream on YYYY-MM-DD" and continue.

No commit.

---

## Task 1: Responses-routing module (whitelist + runtime cache)

**Files:**
- Create: `src/lib/responses-routing.ts`
- Create: `tests/responses-routing.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/responses-routing.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test"

import {
  shouldUseResponsesEndpoint,
  rebuildWhitelistFromModels,
  recordResponsesOnlyModel,
  resetResponsesRouting,
} from "../src/lib/responses-routing"
import type { Model } from "../src/services/copilot/get-models"

const makeModel = (id: string, type: string): Model =>
  ({
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      type,
      limits: {},
      supports: {},
    },
  }) as Model

describe("responses-routing", () => {
  beforeEach(() => {
    resetResponsesRouting()
  })

  test("shouldUseResponsesEndpoint returns false for unknown model", () => {
    expect(shouldUseResponsesEndpoint("gpt-4o")).toBe(false)
  })

  test("rebuildWhitelistFromModels picks up models with type === 'responses'", () => {
    rebuildWhitelistFromModels([
      makeModel("gpt-4o", "chat"),
      makeModel("gpt-5.5", "responses"),
    ])
    expect(shouldUseResponsesEndpoint("gpt-5.5")).toBe(true)
    expect(shouldUseResponsesEndpoint("gpt-4o")).toBe(false)
  })

  test("recordResponsesOnlyModel adds to runtime cache", () => {
    expect(shouldUseResponsesEndpoint("gpt-x")).toBe(false)
    recordResponsesOnlyModel("gpt-x")
    expect(shouldUseResponsesEndpoint("gpt-x")).toBe(true)
  })

  test("rebuildWhitelistFromModels does not clear runtime cache", () => {
    recordResponsesOnlyModel("gpt-secret")
    rebuildWhitelistFromModels([makeModel("gpt-4o", "chat")])
    expect(shouldUseResponsesEndpoint("gpt-secret")).toBe(true)
  })

  test("rebuildWhitelistFromModels replaces previous static whitelist", () => {
    rebuildWhitelistFromModels([makeModel("gpt-5.5", "responses")])
    expect(shouldUseResponsesEndpoint("gpt-5.5")).toBe(true)
    rebuildWhitelistFromModels([makeModel("gpt-4o", "chat")])
    expect(shouldUseResponsesEndpoint("gpt-5.5")).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/responses-routing.test.ts
```

Expected: FAIL — `Cannot find module '../src/lib/responses-routing'`.

- [ ] **Step 3: Implement the module**

Create `src/lib/responses-routing.ts`:

```typescript
import type { Model } from "~/services/copilot/get-models"

let staticWhitelist: Set<string> = new Set()
const runtimeCache: Set<string> = new Set()

export function shouldUseResponsesEndpoint(modelId: string): boolean {
  return staticWhitelist.has(modelId) || runtimeCache.has(modelId)
}

export function rebuildWhitelistFromModels(models: Array<Model>): void {
  const next = new Set<string>()
  for (const model of models) {
    if (model.capabilities?.type === "responses") {
      next.add(model.id)
    }
  }
  staticWhitelist = next
}

export function recordResponsesOnlyModel(modelId: string): void {
  runtimeCache.add(modelId)
}

// Test-only helper. Do not call from production code paths.
export function resetResponsesRouting(): void {
  staticWhitelist = new Set()
  runtimeCache.clear()
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/responses-routing.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/responses-routing.ts tests/responses-routing.test.ts
git commit -m "feat(routing): add responses-endpoint whitelist + runtime cache"
```

---

## Task 2: Wire whitelist rebuild into model fetching

**Files:**
- Modify: `src/services/copilot/get-models.ts`

- [ ] **Step 1: Read current `get-models.ts`**

```bash
cat src/services/copilot/get-models.ts
```

- [ ] **Step 2: Modify `getModels` to rebuild whitelist on success**

Replace the body of `getModels` so the function returns the response after rebuilding:

```typescript
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { rebuildWhitelistFromModels } from "~/lib/responses-routing"
import { state } from "~/lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  const data = (await response.json()) as ModelsResponse
  rebuildWhitelistFromModels(data.data)
  return data
}
```

(Leave the type definitions below the function unchanged.)

- [ ] **Step 3: Verify typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/copilot/get-models.ts
git commit -m "feat(models): rebuild responses whitelist when models are fetched"
```

---

## Task 3: Upstream `create-responses` service

**Files:**
- Create: `src/services/copilot/create-responses.ts`

- [ ] **Step 1: Implement the upstream service**

Create `src/services/copilot/create-responses.ts`:

```typescript
import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createResponses = async (
  payload: ResponsesPayload,
  options?: { signal?: AbortSignal },
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Vision detection: any input item carrying an input_image part.
  const enableVision =
    Array.isArray(payload.input)
    && payload.input.some(
      (item) =>
        typeof item === "object"
        && item !== null
        && "content" in item
        && Array.isArray((item as { content?: unknown }).content)
        && ((item as { content: Array<{ type?: string }> }).content).some(
          (c) => c.type === "input_image",
        ),
    )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
  }

  consola.info(
    "Sending to upstream /responses, model:",
    payload.model,
    "stream:",
    !!payload.stream,
  )

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options?.signal,
  })

  if (!response.ok) {
    const bodyText = await response.text()
    consola.error("HTTP error (/responses):", bodyText)
    throw new HTTPError("Failed to create responses", response, bodyText)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

// ---- Request types --------------------------------------------------------

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string | null
  stream?: boolean | null
  store?: boolean | null
  previous_response_id?: string | null
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stop?: string | Array<string> | null
  tools?: Array<ResponsesTool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; name: string }
    | null
  reasoning?: { effort?: "low" | "medium" | "high" } | null
  modalities?: Array<string> | null
  metadata?: Record<string, string> | null
  user?: string | null
  truncation?: "auto" | "disabled" | null
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

export interface ResponsesMessageItem {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: Array<ResponsesContentPart>
}

export interface ResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; file_id: string }

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
}

// ---- Response types -------------------------------------------------------

export interface ResponsesResponse {
  id: string
  object: "response"
  created_at: number
  status: "completed" | "in_progress" | "failed" | "incomplete"
  model: string
  instructions?: string | null
  output: Array<ResponsesOutputItem>
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message: string; code?: string } | null
  metadata?: Record<string, string>
  incomplete_details?: { reason?: string } | null
}

export type ResponsesOutputItem =
  | ResponsesMessageOutput
  | ResponsesFunctionCallOutput
  | ResponsesReasoningOutput

export interface ResponsesMessageOutput {
  type: "message"
  id: string
  status: "completed" | "in_progress"
  role: "assistant"
  content: Array<
    | { type: "output_text"; text: string; annotations?: Array<unknown> }
    | { type: "refusal"; refusal: string }
  >
}

export interface ResponsesFunctionCallOutput {
  type: "function_call"
  id: string
  call_id: string
  name: string
  arguments: string
  status: "completed" | "in_progress"
}

export interface ResponsesReasoningOutput {
  type: "reasoning"
  id: string
  summary: Array<{ type: "summary_text"; text: string }>
}
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/copilot/create-responses.ts
git commit -m "feat(services): add Copilot /responses upstream service"
```

---

## Task 4: Translation — Chat Completions request → Responses request

**Files:**
- Create: `src/lib/translation/chat-to-responses.ts`
- Create: `tests/translation-chat-to-responses.test.ts`

- [ ] **Step 1: Write failing tests for request translation**

Create `tests/translation-chat-to-responses.test.ts`:

```typescript
import { describe, test, expect } from "bun:test"

import { chatRequestToResponses } from "../src/lib/translation/chat-to-responses"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

describe("chatRequestToResponses", () => {
  test("user-only message becomes input array with input_text", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    }
    const out = chatRequestToResponses(chat)
    expect(out.model).toBe("gpt-5.5")
    expect(out.store).toBe(false)
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ])
    expect(out.instructions).toBeUndefined()
  })

  test("system messages become top-level instructions, joined", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "be terse" },
        { role: "system", content: "use english" },
        { role: "user", content: "hi" },
      ],
    }
    const out = chatRequestToResponses(chat)
    expect(out.instructions).toBe("be terse\n\nuse english")
    // system messages are stripped from input
    expect(Array.isArray(out.input)).toBe(true)
    expect((out.input as Array<{ role: string }>).every((i) => i.role !== "system")).toBe(
      true,
    )
  })

  test("assistant tool_calls become function_call input items", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    }
    const out = chatRequestToResponses(chat)
    const items = out.input as Array<Record<string, unknown>>
    expect(items[1]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"NYC"}',
    })
    expect(items[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "sunny",
    })
  })

  test("image_url content becomes input_image", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aaa" },
            },
          ],
        },
      ],
    }
    const out = chatRequestToResponses(chat)
    const items = out.input as Array<{
      content: Array<{ type: string; text?: string; image_url?: string }>
    }>
    expect(items[0].content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: "data:image/png;base64,aaa" },
    ])
  })

  test("max_tokens is renamed to max_output_tokens", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
    }
    const out = chatRequestToResponses(chat)
    expect(out.max_output_tokens).toBe(256)
    expect((out as Record<string, unknown>).max_tokens).toBeUndefined()
  })

  test("tools are flattened from {function:{}} to top-level fields", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }
    const out = chatRequestToResponses(chat)
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "weather",
        parameters: { type: "object", properties: {} },
      },
    ])
  })

  test("stream + temperature + top_p + stop pass through", () => {
    const chat: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
      stop: ["END"],
    }
    const out = chatRequestToResponses(chat)
    expect(out.stream).toBe(true)
    expect(out.temperature).toBe(0.5)
    expect(out.top_p).toBe(0.9)
    expect(out.stop).toEqual(["END"])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/translation-chat-to-responses.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement request translation**

Create `src/lib/translation/chat-to-responses.ts`:

```typescript
import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesPayload,
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

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
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
      role: msg.role as "user" | "assistant",
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
  if (chat.tool_choice != null) out.tool_choice = translateToolChoice(chat.tool_choice)
  if (chat.tools != null) out.tools = chat.tools.map(translateTool)

  // Optional extension: clients (Claude Code etc.) sometimes forward
  // reasoning_effort. Pass it through as Responses' reasoning.effort.
  const maybeReasoning = (chat as { reasoning_effort?: string }).reasoning_effort
  if (maybeReasoning === "low" || maybeReasoning === "medium" || maybeReasoning === "high") {
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
  return content.map(translatePart).filter(Boolean) as Array<ResponsesContentPart>
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/translation-chat-to-responses.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/translation/chat-to-responses.ts tests/translation-chat-to-responses.test.ts
git commit -m "feat(translation): chat-completions request → responses request"
```

---

## Task 5: Translation — Responses non-streaming response → Chat Completions response

**Files:**
- Modify: `src/lib/translation/chat-to-responses.ts`
- Modify: `tests/translation-chat-to-responses.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/translation-chat-to-responses.test.ts`:

```typescript
import { responsesToChatResponse } from "../src/lib/translation/chat-to-responses"
import type { ResponsesResponse } from "../src/services/copilot/create-responses"

describe("responsesToChatResponse", () => {
  test("plain message output becomes single choice with content string", () => {
    const resp: ResponsesResponse = {
      id: "resp_1",
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          id: "msg_1",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "hello " },
            { type: "output_text", text: "world" },
          ],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    }
    const out = responsesToChatResponse(resp)
    expect(out.id.startsWith("chatcmpl-")).toBe(true)
    expect(out.object).toBe("chat.completion")
    expect(out.model).toBe("gpt-5.5")
    expect(out.choices).toHaveLength(1)
    expect(out.choices[0].finish_reason).toBe("stop")
    expect(out.choices[0].message.role).toBe("assistant")
    expect(out.choices[0].message.content).toBe("hello world")
    expect(out.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    })
  })

  test("function_call output becomes message.tool_calls", () => {
    const resp: ResponsesResponse = {
      id: "resp_2",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
          status: "completed",
        },
      ],
    }
    const out = responsesToChatResponse(resp)
    expect(out.choices[0].finish_reason).toBe("tool_calls")
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      },
    ])
    expect(out.choices[0].message.content).toBeNull()
  })

  test("incomplete status maps to length finish_reason", () => {
    const resp: ResponsesResponse = {
      id: "resp_3",
      object: "response",
      created_at: 1,
      status: "incomplete",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          id: "msg",
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "partial" }],
        },
      ],
      incomplete_details: { reason: "max_output_tokens" },
    }
    const out = responsesToChatResponse(resp)
    expect(out.choices[0].finish_reason).toBe("length")
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
bun test tests/translation-chat-to-responses.test.ts
```

Expected: existing 7 PASS, new 3 FAIL — `responsesToChatResponse is not a function`.

- [ ] **Step 3: Implement `responsesToChatResponse`**

Append to `src/lib/translation/chat-to-responses.ts`:

```typescript
import type {
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesFunctionCallOutput,
  ResponsesMessageOutput,
  ResponsesResponse,
} from "~/services/copilot/create-responses"

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/translation-chat-to-responses.test.ts
```

Expected: PASS, 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/lib/translation/chat-to-responses.ts tests/translation-chat-to-responses.test.ts
git commit -m "feat(translation): responses → chat-completions non-streaming response"
```

---

## Task 6: Translation — Responses SSE stream → Chat Completions chunk stream

**Files:**
- Modify: `src/lib/translation/chat-to-responses.ts`
- Modify: `tests/translation-chat-to-responses.test.ts`

- [ ] **Step 1: Add failing tests for streaming**

Append to `tests/translation-chat-to-responses.test.ts`:

```typescript
import { responsesStreamToChatStream } from "../src/lib/translation/chat-to-responses"

async function* fromArray<T>(items: Array<T>): AsyncGenerator<T> {
  for (const it of items) yield it
}

async function collect(
  it: AsyncIterable<{ data?: string }>,
): Promise<Array<string>> {
  const out: Array<string> = []
  for await (const chunk of it) {
    if (chunk.data !== undefined) out.push(chunk.data)
  }
  return out
}

describe("responsesStreamToChatStream", () => {
  test("translates text deltas, leading role chunk, and final stop", async () => {
    const upstream = fromArray([
      { event: "response.created", data: JSON.stringify({ response: { id: "r1", model: "gpt-5.5" } }) },
      { event: "response.output_text.delta", data: JSON.stringify({ delta: "hi " }) },
      { event: "response.output_text.delta", data: JSON.stringify({ delta: "there" }) },
      { event: "response.completed", data: JSON.stringify({ response: { id: "r1", model: "gpt-5.5", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }) },
    ])

    const out = await collect(responsesStreamToChatStream(upstream, "gpt-5.5"))

    // Last chunk must be [DONE]
    expect(out[out.length - 1]).toBe("[DONE]")
    // First content chunk should carry role assistant
    const parsed = out.slice(0, -1).map((d) => JSON.parse(d) as Record<string, any>)
    expect(parsed[0].choices[0].delta.role).toBe("assistant")
    // Concatenated content equals "hi there"
    const concatenated = parsed
      .map((c) => c.choices[0].delta.content as string | undefined)
      .filter((x) => typeof x === "string")
      .join("")
    expect(concatenated).toBe("hi there")
    // A chunk with finish_reason "stop" must exist
    expect(parsed.some((c) => c.choices[0].finish_reason === "stop")).toBe(true)
    // A chunk must carry usage
    expect(
      parsed.some(
        (c) =>
          c.usage
          && c.usage.prompt_tokens === 1
          && c.usage.completion_tokens === 2,
      ),
    ).toBe(true)
  })

  test("translates function_call_arguments deltas to tool_call deltas", async () => {
    const upstream = fromArray([
      { event: "response.created", data: JSON.stringify({ response: { id: "r2" } }) },
      {
        event: "response.output_item.added",
        data: JSON.stringify({
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
            arguments: "",
            status: "in_progress",
          },
        }),
      },
      {
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({ output_index: 0, call_id: "call_1", delta: '{"city":' }),
      },
      {
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({ output_index: 0, call_id: "call_1", delta: '"NYC"}' }),
      },
      { event: "response.completed", data: JSON.stringify({ response: { id: "r2" } }) },
    ])

    const out = await collect(responsesStreamToChatStream(upstream, "gpt-5.5"))
    const parsed = out.slice(0, -1).map((d) => JSON.parse(d) as Record<string, any>)
    // Find the chunk that introduces the tool call (carries name + id)
    const introChunk = parsed.find(
      (c) => c.choices[0].delta.tool_calls?.[0]?.function?.name === "get_weather",
    )
    expect(introChunk).toBeDefined()
    expect(introChunk!.choices[0].delta.tool_calls[0].id).toBe("call_1")
    expect(introChunk!.choices[0].delta.tool_calls[0].index).toBe(0)
    // Concatenated arguments equal the full JSON
    const args = parsed
      .map((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments as string | undefined)
      .filter((x) => typeof x === "string")
      .join("")
    expect(args).toBe('{"city":"NYC"}')
    // Final chunk should have finish_reason tool_calls
    expect(
      parsed.some((c) => c.choices[0].finish_reason === "tool_calls"),
    ).toBe(true)
  })

  test("response.failed surfaces an error chunk and DONE", async () => {
    const upstream = fromArray([
      { event: "response.created", data: JSON.stringify({ response: { id: "r3" } }) },
      {
        event: "response.failed",
        data: JSON.stringify({ response: { id: "r3", error: { message: "boom" } } }),
      },
    ])
    const out = await collect(responsesStreamToChatStream(upstream, "gpt-5.5"))
    expect(out[out.length - 1]).toBe("[DONE]")
    const errorChunk = out
      .slice(0, -1)
      .map((d) => JSON.parse(d) as Record<string, any>)
      .find((c) => c.error)
    expect(errorChunk).toBeDefined()
    expect(errorChunk!.error.message).toBe("boom")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/translation-chat-to-responses.test.ts
```

Expected: previous tests PASS, 3 new ones FAIL — `responsesStreamToChatStream is not a function`.

- [ ] **Step 3: Implement `responsesStreamToChatStream`**

Append to `src/lib/translation/chat-to-responses.ts`:

```typescript
import consola from "consola"

interface UpstreamSseEvent {
  event?: string
  data?: string
}

interface ChatChunkOut {
  data: string
}

// Maps Copilot /responses SSE events to OpenAI-style chat.completion.chunk SSE.
// Yields objects shaped like { data: string } to match `events()` from
// fetch-event-stream so callers (chat-completions handler) can pipe them through
// without changes. Always ends with a `{ data: "[DONE]" }` sentinel.
export async function* responsesStreamToChatStream(
  upstream: AsyncIterable<UpstreamSseEvent>,
  model: string,
): AsyncGenerator<ChatChunkOut> {
  let id = `chatcmpl-stream-${Date.now()}`
  let emittedRole = false
  let sawToolCall = false
  // call_id → index assignment so deltas can be merged client-side
  const callIndex = new Map<string, number>()
  let nextIndex = 0

  const baseChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, delta, finish_reason: finish, logprobs: null },
      ],
    })

  for await (const evt of upstream) {
    if (!evt.event || evt.data === undefined) continue
    let payload: Record<string, any> = {}
    try {
      payload = JSON.parse(evt.data) as Record<string, any>
    } catch {
      continue
    }

    switch (evt.event) {
      case "response.created": {
        if (payload.response?.id) id = `chatcmpl-${payload.response.id}`
        // Emit a leading chunk with role:"assistant" so chat clients
        // can latch onto the assistant turn before content arrives.
        emittedRole = true
        yield { data: baseChunk({ role: "assistant" }) }
        break
      }

      case "response.output_text.delta": {
        const delta = payload.delta as string | undefined
        if (typeof delta !== "string") break
        if (!emittedRole) {
          emittedRole = true
          yield { data: baseChunk({ role: "assistant", content: delta }) }
        } else {
          yield { data: baseChunk({ content: delta }) }
        }
        break
      }

      case "response.output_item.added": {
        const item = payload.item as
          | { type?: string; call_id?: string; name?: string }
          | undefined
        if (item?.type === "function_call" && item.call_id) {
          sawToolCall = true
          const idx = nextIndex++
          callIndex.set(item.call_id, idx)
          yield {
            data: baseChunk({
              tool_calls: [
                {
                  index: idx,
                  id: item.call_id,
                  type: "function",
                  function: { name: item.name ?? "", arguments: "" },
                },
              ],
            }),
          }
        }
        break
      }

      case "response.function_call_arguments.delta": {
        const delta = payload.delta as string | undefined
        const callId = payload.call_id as string | undefined
        if (typeof delta !== "string" || !callId) break
        const idx = callIndex.get(callId) ?? 0
        sawToolCall = true
        yield {
          data: baseChunk({
            tool_calls: [
              {
                index: idx,
                function: { arguments: delta },
              },
            ],
          }),
        }
        break
      }

      case "response.completed": {
        const usage = payload.response?.usage as
          | {
              input_tokens?: number
              output_tokens?: number
              total_tokens?: number
            }
          | undefined
        const finalChoices = [
          {
            index: 0,
            delta: {},
            finish_reason: sawToolCall ? "tool_calls" : "stop",
            logprobs: null,
          },
        ]
        const final = JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: finalChoices,
          usage: usage
            ? {
                prompt_tokens: usage.input_tokens ?? 0,
                completion_tokens: usage.output_tokens ?? 0,
                total_tokens: usage.total_tokens ?? 0,
              }
            : undefined,
        })
        yield { data: final }
        yield { data: "[DONE]" }
        return
      }

      case "response.failed":
      case "response.error": {
        const message =
          (payload.response?.error?.message as string | undefined)
          ?? (payload.error?.message as string | undefined)
          ?? "responses upstream error"
        yield {
          data: JSON.stringify({
            error: { message, type: "upstream_error" },
          }),
        }
        yield { data: "[DONE]" }
        return
      }

      default: {
        // Silently ignore other event types (in_progress, content_part.*, etc.)
        consola.debug("responsesStreamToChatStream: ignoring event", evt.event)
      }
    }
  }

  // Upstream ended without `response.completed` — close gracefully.
  yield {
    data: baseChunk({}, sawToolCall ? "tool_calls" : "stop"),
  }
  yield { data: "[DONE]" }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/translation-chat-to-responses.test.ts
```

Expected: PASS, 13 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/lib/translation/chat-to-responses.ts tests/translation-chat-to-responses.test.ts
git commit -m "feat(translation): responses SSE → chat-completions chunk stream"
```

---

## Task 7: Hook fallback into `create-chat-completions`

**Files:**
- Modify: `src/services/copilot/create-chat-completions.ts`
- Create: `tests/chat-to-responses-fallback.test.ts`

- [ ] **Step 1: Write failing fallback tests**

Create `tests/chat-to-responses-fallback.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import {
  recordResponsesOnlyModel,
  resetResponsesRouting,
} from "../src/lib/responses-routing"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

const realFetch = globalThis.fetch

beforeEach(() => {
  resetResponsesRouting()
  state.copilotToken = "test-token"
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createChatCompletions fallback to /responses", () => {
  test("when whitelist has model, calls /responses directly and returns chat-shaped response", async () => {
    recordResponsesOnlyModel("gpt-5.5")
    const calls: Array<string> = []
    globalThis.fetch = ((input: RequestInfo) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push(url)
      return Promise.resolve(
        jsonResponse({
          id: "resp_1",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "hi" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      )
    }) as typeof fetch

    const result = await createChatCompletions({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].endsWith("/responses")).toBe(true)
    if ("choices" in (result as object)) {
      expect((result as any).choices[0].message.content).toBe("hi")
      expect((result as any).object).toBe("chat.completion")
    } else {
      throw new Error("expected non-streaming chat completion shape")
    }
  })

  test("auto-fallback on unsupported_api_for_model error", async () => {
    const seen: Array<string> = []
    globalThis.fetch = ((input: RequestInfo) => {
      const url = typeof input === "string" ? input : (input as Request).url
      seen.push(url)
      if (url.endsWith("/chat/completions")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                message:
                  'model "gpt-5.5" is not accessible via the /chat/completions endpoint',
                code: "unsupported_api_for_model",
              },
            },
            400,
          ),
        )
      }
      return Promise.resolve(
        jsonResponse({
          id: "resp_2",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              id: "msg",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
      )
    }) as typeof fetch

    const result = await createChatCompletions({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(seen[0].endsWith("/chat/completions")).toBe(true)
    expect(seen[1].endsWith("/responses")).toBe(true)
    expect((result as any).choices[0].message.content).toBe("ok")
  })

  test("non-fallback errors are not retried", async () => {
    const seen: Array<string> = []
    globalThis.fetch = ((input: RequestInfo) => {
      const url = typeof input === "string" ? input : (input as Request).url
      seen.push(url)
      return Promise.resolve(
        jsonResponse({ error: { message: "rate limited", code: "rate_limit_exceeded" } }, 429),
      )
    }) as typeof fetch

    await expect(
      createChatCompletions({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0].endsWith("/chat/completions")).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/chat-to-responses-fallback.test.ts
```

Expected: FAIL (current `createChatCompletions` knows nothing about `/responses`).

- [ ] **Step 3: Modify `create-chat-completions.ts` to call routing + fallback**

Open `src/services/copilot/create-chat-completions.ts`. Replace the **whole `createChatCompletions` function** (keep all existing types below it untouched) with:

```typescript
import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  recordResponsesOnlyModel,
  shouldUseResponsesEndpoint,
} from "~/lib/responses-routing"
import { state } from "~/lib/state"
import {
  chatRequestToResponses,
  responsesStreamToChatStream,
  responsesToChatResponse,
} from "~/lib/translation/chat-to-responses"
import { createResponses } from "~/services/copilot/create-responses"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options?: { signal?: AbortSignal },
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Route Responses-only models (whitelisted at /models fetch time, or learned
  // via the runtime cache after a previous unsupported_api_for_model failure)
  // straight to the /responses upstream. Translate the response back to chat
  // shape so the caller sees no protocol difference.
  if (shouldUseResponsesEndpoint(payload.model)) {
    return callViaResponses(payload, options)
  }

  try {
    return await callChatCompletions(payload, options)
  } catch (error) {
    if (isUnsupportedApiForModelError(error)) {
      consola.warn(
        `Model "${payload.model}" not available on /chat/completions; retrying via /responses.`,
      )
      recordResponsesOnlyModel(payload.model)
      return callViaResponses(payload, options)
    }
    throw error
  }
}

async function callChatCompletions(
  payload: ChatCompletionsPayload,
  options?: { signal?: AbortSignal },
) {
  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  consola.info("Sending to upstream, message count:", payload.messages.length)

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options?.signal,
  })

  if (!response.ok) {
    const bodyText = await response.text()
    consola.error("HTTP error:", bodyText)
    throw new HTTPError("Failed to create chat completions", response, bodyText)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

async function callViaResponses(
  payload: ChatCompletionsPayload,
  options?: { signal?: AbortSignal },
) {
  const responsesPayload = chatRequestToResponses(payload)
  const upstream = await createResponses(responsesPayload, options)

  if (payload.stream) {
    return responsesStreamToChatStream(
      upstream as AsyncIterable<{ event?: string; data?: string }>,
      payload.model,
    )
  }

  return responsesToChatResponse(upstream as Awaited<ReturnType<typeof createResponses>> as any)
}

function isUnsupportedApiForModelError(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  const text = error.bodyText
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string } }
    return parsed.error?.code === "unsupported_api_for_model"
  } catch {
    return text.includes("unsupported_api_for_model")
  }
}
```

(Leave all type definitions below the function unchanged.)

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: every test passes (existing + 3 new fallback tests).

- [ ] **Step 5: Run typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/copilot/create-chat-completions.ts tests/chat-to-responses-fallback.test.ts
git commit -m "feat(chat-completions): transparent fallback to /responses for unsupported models"
```

---

## Task 8: Public `/v1/responses` endpoint

**Files:**
- Create: `src/routes/responses/route.ts`
- Create: `src/routes/responses/handler.ts`
- Create: `tests/responses-endpoint.test.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Write failing endpoint tests**

Create `tests/responses-endpoint.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { responsesRoutes } from "../src/routes/responses/route"

const realFetch = globalThis.fetch

beforeEach(() => {
  state.copilotToken = "test-token"
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("/v1/responses route", () => {
  test("non-streaming: forwards upstream JSON verbatim", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ id: "resp_1", object: "response", status: "completed" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as typeof fetch

    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; object: string }
    expect(body.id).toBe("resp_1")
    expect(body.object).toBe("response")
  })

  test("rejects previous_response_id with 400", async () => {
    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "hi",
        previous_response_id: "resp_prev",
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("previous_response_id")
  })

  test("missing model returns 400", async () => {
    const res = await responsesRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/responses-endpoint.test.ts
```

Expected: FAIL — `Cannot find module '../src/routes/responses/route'`.

- [ ] **Step 3: Implement the handler**

Create `src/routes/responses/handler.ts`:

```typescript
import type { Context } from "hono"

import { z } from "zod"

import { HTTPError } from "~/lib/error"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const requestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.any())]),
    instructions: z.string().nullish(),
    stream: z.boolean().nullish(),
    store: z.boolean().nullish(),
    previous_response_id: z.string().nullish(),
    max_output_tokens: z.number().int().nullish(),
    temperature: z.number().nullish(),
    top_p: z.number().nullish(),
    stop: z.union([z.string(), z.array(z.string())]).nullish(),
    tools: z.array(z.any()).nullish(),
    tool_choice: z.any().nullish(),
    reasoning: z.any().nullish(),
    modalities: z.array(z.string()).nullish(),
    metadata: z.record(z.string(), z.string()).nullish(),
    user: z.string().nullish(),
    truncation: z.enum(["auto", "disabled"]).nullish(),
  })
  .passthrough()

export async function handleResponses(c: Context) {
  const raw = await c.req.json<unknown>()
  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          message: `Invalid /v1/responses payload: ${parsed.error.message}`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const body = parsed.data
  if (body.previous_response_id) {
    return c.json(
      {
        error: {
          message:
            "previous_response_id is not supported by this proxy (server-side conversation state is disabled)",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  // Force store: false; we don't want Copilot to retain state on our behalf.
  const payload: ResponsesPayload = {
    ...(body as ResponsesPayload),
    store: false,
  }

  const upstreamController = new AbortController()
  c.req.raw.signal?.addEventListener("abort", () => upstreamController.abort())

  const upstream = await createResponses(payload, {
    signal: upstreamController.signal,
  })

  if (payload.stream) {
    // Pass-through SSE: serialise each event back into the SSE wire format.
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          try {
            for await (const evt of upstream as AsyncIterable<{
              event?: string
              data?: string
            }>) {
              if (evt.event) controller.enqueue(encoder.encode(`event: ${evt.event}\n`))
              if (evt.data !== undefined)
                controller.enqueue(encoder.encode(`data: ${evt.data}\n\n`))
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            controller.enqueue(
              encoder.encode(
                `event: response.error\ndata: ${JSON.stringify({ error: { message } })}\n\n`,
              ),
            )
          } finally {
            controller.close()
          }
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    )
  }

  if (upstream instanceof Response) {
    // defensive — createResponses normally returns parsed JSON or AsyncIterable
    throw new HTTPError("Unexpected upstream response type", upstream)
  }

  return c.json(upstream)
}
```

Create `src/routes/responses/route.ts`:

```typescript
import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return forwardError(c, error)
  }
})
```

- [ ] **Step 4: Run endpoint tests**

```bash
bun test tests/responses-endpoint.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Mount the route in `src/server.ts`**

Add the import next to other route imports:

```typescript
import { responsesRoutes } from "./routes/responses/route"
```

Add a `requireCopilotReady` line alongside the others:

```typescript
server.use("/responses/*", requireCopilotReady())
```

Add two route mounts (the existing `/v1/*` `requireCopilotReady` already covers `/v1/responses`):

```typescript
server.route("/responses", responsesRoutes)
server.route("/v1/responses", responsesRoutes)
```

- [ ] **Step 6: Run full test + typecheck + lint**

```bash
bun test && bun run typecheck && bun run lint
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/routes/responses/route.ts src/routes/responses/handler.ts \
  tests/responses-endpoint.test.ts src/server.ts
git commit -m "feat(routes): add /v1/responses passthrough endpoint"
```

---

## Task 9: Manual end-to-end smoke against real Copilot

**Files:** none committed.

- [ ] **Step 1: Auth and start the server**

```bash
bun run start --port 4141
```

(In a separate shell.)

- [ ] **Step 2: Verify `/copilot-models` shows `gpt-5.5` was auto-whitelisted**

Hit:

```bash
curl -s http://localhost:4141/admin/api/models | jq '.data[] | select(.id == "gpt-5.5") | .capabilities.type'
```

Expected output: `"responses"` (or whatever Task 0 confirmed).

- [ ] **Step 3: Smoke `/chat/completions` with `gpt-5.5` (transparent fallback)**

```bash
curl -sS http://localhost:4141/v1/chat/completions \
  -H "Authorization: Bearer $YOUR_PROXY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"hello"}]}' | jq
```

Expected: a valid `chat.completion` JSON with `choices[0].message.content` non-empty.

- [ ] **Step 4: Smoke `/v1/responses` directly**

```bash
curl -sS http://localhost:4141/v1/responses \
  -H "Authorization: Bearer $YOUR_PROXY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","input":"hello"}' | jq
```

Expected: a valid `response` JSON.

- [ ] **Step 5: Smoke streaming for both**

```bash
curl -N -sS http://localhost:4141/v1/chat/completions \
  -H "Authorization: Bearer $YOUR_PROXY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Expected: SSE chunks with `chat.completion.chunk` objects ending in `data: [DONE]`.

If anything fails, debug, fix, and re-run earlier task tests (`bun test`) before continuing.

---

## Task 10: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the endpoints section**

```bash
grep -n -E '^(##|#) ' README.md | head -40
```

Identify a logical place — likely right after the chat-completions / messages section.

- [ ] **Step 2: Add a "Responses API support" section**

Insert (preserving surrounding heading levels):

```markdown
## Responses API support

This proxy can use Copilot models that the upstream only exposes via its OpenAI-compatible `/responses` endpoint (such as `gpt-5.5`).

Two paths are provided:

### 1. Direct `/v1/responses` endpoint

OpenAI-compatible Responses API. Use it directly with the OpenAI SDK:

```ts
import OpenAI from "openai"

const client = new OpenAI({
  baseURL: "http://localhost:4141/v1",
  apiKey: process.env.PROXY_TOKEN,
})

const response = await client.responses.create({
  model: "gpt-5.5",
  input: "Hello!",
})
console.log(response.output[0])
```

Or with curl:

```bash
curl -sS http://localhost:4141/v1/responses \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","input":"hello"}'
```

> Server-side conversation state (`previous_response_id`, `store: true`) is **not** supported and will return `400`. The proxy is stateless.

### 2. Transparent fallback for `/chat/completions` and `/v1/messages`

Clients that speak Chat Completions or Anthropic Messages can use Responses-only models without any change. The proxy detects them in two ways:

1. **Auto-whitelist:** at startup (and on every model refresh) it scans `/models` and marks any model whose `capabilities.type === "responses"` as Responses-only.
2. **Runtime fallback:** if `/chat/completions` returns `unsupported_api_for_model`, the proxy retries via `/responses` and remembers the model for subsequent calls.

The chat-shaped clients see standard `chat.completion` (or Anthropic Messages) responses; the translation happens internally.
```

- [ ] **Step 3: Sanity-check rendered Markdown**

```bash
grep -A2 "Responses API support" README.md | head -10
```

Expected: heading appears.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document /v1/responses endpoint and transparent fallback"
```

---

## Task 11: Final verification

- [ ] **Step 1: Run the whole test suite**

```bash
bun test
```

Expected: all pass.

- [ ] **Step 2: Typecheck, lint, knip**

```bash
bun run typecheck && bun run lint && bun run knip
```

Expected: clean. If `knip` flags `resetResponsesRouting` as unused outside tests, that's fine — leave it for tests.

- [ ] **Step 3: Confirm git log shows clean, atomic commits**

```bash
git log --oneline -20
```

Expected: each task got its own commit with a descriptive subject.

- [ ] **Step 4: Done — hand back to user**

Summarise what shipped, link to the spec, and call out the deferred admin Models page badge as a possible follow-up.
