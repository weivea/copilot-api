# API Export Upgrade for Copilot 2026-01-09 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the four exported `/v1/{chat/completions,responses,messages,embeddings}` endpoints with the upstream Copilot 2026-01-09 API: complete TS types, capture & propagate `copilot_info_messages` (log + non-stream passthrough + Anthropic SSE event), record per-request `copilot_usage.total_nano_aiu` into `request_logs`, fix `EmbeddingResponse` honesty, and run a fail-fast drizzle migration at startup.

**Architecture:** Additive on every axis — every new response field is optional, the new `cost_nano_aiu` column is nullable, no SSE frame order changes, the new Anthropic `copilot_info` event sits between the existing `content_block_stop` and `message_delta` frames and is ignored by SDKs that do not recognize it.

**Tech Stack:** Bun · Hono · TypeScript (strict) · drizzle-orm (bun-sqlite) · consola · fetch-event-stream · Zod

**Spec:** `docs/superpowers/specs/2026-05-22-api-export-upgrade-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/services/copilot/types-shared.ts` | **new** | `CopilotUsage`, `CopilotInfoMessage` shared between chat/completions and responses |
| `src/services/copilot/create-chat-completions.ts` | modify | Add new optional fields to `ChatCompletionResponse` and `ChatCompletionChunk` |
| `src/services/copilot/create-responses.ts` | modify | Add new optional fields to `ResponsesResponse`, `ResponsesMessageOutput` |
| `src/services/copilot/create-embeddings.ts` | modify | Make `object` / `model` optional on `EmbeddingResponse` |
| `src/lib/copilot-info-messages.ts` | **new** | `captureInfoMessages()` (log + idempotency) and `pickCostNanoAiu()` |
| `src/routes/embeddings/route.ts` | modify | Drop now-unneeded cast acrobatics |
| `src/routes/chat-completions/handler.ts` | modify | Capture info_messages, accumulate cost, pass to `recordUsage` |
| `src/routes/messages/handler.ts` | modify | Capture info_messages + cost; stream emits new `copilot_info` event |
| `src/routes/messages/non-stream-translation.ts` | modify | Mount `copilot_info_messages` on `AnthropicResponse` |
| `src/routes/messages/anthropic-types.ts` | modify | Add `copilot_info_messages` to `AnthropicResponse`; extend `AnthropicStreamState` |
| `src/routes/responses/handler.ts` | modify | Non-stream: log + cost. Stream: parse `response.completed` for log + cost. Call `recordUsage`. |
| `src/db/schema.ts` | modify | Add `costNanoAiu` column on `requestLogs` |
| `src/db/queries/request-logs.ts` | modify | `NewRequestLog` + `insertRequestLog` carry the new column |
| `src/db/client.ts` | modify | Wrap existing `migrate()` in try/catch; resolve folder for dev + packaged |
| `src/lib/usage-recorder.ts` | modify | `PendingUsage` + `recordUsage` carry `costNanoAiu`; track `/v1/responses` |
| `drizzle/0001_add_cost_nano_aiu.sql` | **new** | `ALTER TABLE request_logs ADD cost_nano_aiu integer;` |
| `drizzle/meta/_journal.json` | modify | Drizzle-kit records the new entry automatically |
| `tests/copilot-info-messages.test.ts` | **new** | Unit tests for the two helpers |
| `tests/embeddings-handler.test.ts` | **new** | Handler tolerates upstream omitting `object` / `model` |
| `tests/anthropic-response.test.ts` | modify | Add cases for `copilot_info_messages` mount |
| `tests/anthropic-stream-copilot-info.test.ts` | **new** | Stream emits `copilot_info` between `content_block_stop` and `message_delta` |
| `tests/usage-recorder.test.ts` | modify | Add case writing `cost_nano_aiu`; add case tracking `/v1/responses` |
| `tests/db-migration.test.ts` | **new** | Pre-0001 DB upgrades; idempotency; failure rethrows |

---

## Task 1: Shared types module — `CopilotUsage`, `CopilotInfoMessage`

**Files:**
- Create: `src/services/copilot/types-shared.ts`

- [ ] **Step 1: Create the file**

Write `src/services/copilot/types-shared.ts`:

```ts
/**
 * Copilot per-request cost breakdown. Units are nano-AIU (10^-9 AIU).
 * Stable starting with API_VERSION 2026-01-09.
 */
export interface CopilotUsage {
  token_details: Array<{
    batch_size: number
    cost_per_batch: number
    token_count: number
    token_type: "input" | "cache_read" | "cache_write" | "output" | string
  }>
  total_nano_aiu: number
}

/**
 * Out-of-band notifications from upstream. Known codes today:
 *   - "model_pending_deprecation"
 * Open string union so unknown codes still type-check.
 */
export interface CopilotInfoMessage {
  code: "model_pending_deprecation" | string
  message: string
}
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `bun run typecheck`
Expected: 0 errors (file is unused but valid).

- [ ] **Step 3: Commit**

```bash
git add src/services/copilot/types-shared.ts
git commit -m "feat(types): add shared CopilotUsage / CopilotInfoMessage types"
```

---

## Task 2: Augment `ChatCompletionResponse` and `ChatCompletionChunk`

**Files:**
- Modify: `src/services/copilot/create-chat-completions.ts`

- [ ] **Step 1: Add imports for shared types**

Insert near the top of the file (after the existing `import { events }` line):

```ts
import type {
  CopilotInfoMessage,
  CopilotUsage,
} from "./types-shared"
```

- [ ] **Step 2: Update `ChatCompletionResponse`**

Locate `export interface ChatCompletionResponse {` and replace the entire interface with:

```ts
export interface ChatCompletionResponse {
  id: string
  object?: "chat.completion"
  created?: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    reasoning_tokens?: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
  prompt_filter_results?: Array<{
    prompt_index: number
    content_filter_results: Record<string, unknown>
  }>
  copilot_usage?: CopilotUsage
  copilot_info_messages?: Array<CopilotInfoMessage>
}
```

- [ ] **Step 3: Update `ChoiceNonStreaming` and `ResponseMessage`**

Replace the existing `interface ResponseMessage` block with:

```ts
interface ResponseMessage {
  role: "assistant"
  content: string | null
  padding?: string
  tool_calls?: Array<ToolCall>
}
```

Replace the existing `interface ChoiceNonStreaming` block with:

```ts
interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
  content_filter_results?: Record<string, unknown>
}
```

- [ ] **Step 4: Update `ChatCompletionChunk` and `Choice`**

Replace the existing `export interface ChatCompletionChunk` with:

```ts
export interface ChatCompletionChunk {
  id: string
  object?: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  prompt_filter_results?: Array<{
    prompt_index: number
    content_filter_results: Record<string, unknown>
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
  copilot_usage?: CopilotUsage
  copilot_info_messages?: Array<CopilotInfoMessage>
}
```

Replace the existing `interface Choice` block with:

```ts
interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
  content_filter_results?: Record<string, unknown>
}
```

- [ ] **Step 5: Verify typecheck and existing tests pass**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun test tests/anthropic-response.test.ts tests/chat-to-responses-fallback.test.ts tests/anthropic-request.test.ts`
Expected: all green (`object` becoming optional does not break the existing tests; the `responsesToChatResponse` translator sets `object: "chat.completion"` explicitly).

- [ ] **Step 6: Commit**

```bash
git add src/services/copilot/create-chat-completions.ts
git commit -m "feat(types): align ChatCompletionResponse/Chunk with Copilot 2026-01-09"
```

---

## Task 3: Augment `ResponsesResponse` and `ResponsesMessageOutput`

**Files:**
- Modify: `src/services/copilot/create-responses.ts`

- [ ] **Step 1: Import shared types**

Insert under the existing imports:

```ts
import type {
  CopilotInfoMessage,
  CopilotUsage,
} from "./types-shared"
```

- [ ] **Step 2: Update `ResponsesResponse`**

Replace the entire `export interface ResponsesResponse { ... }` block with:

```ts
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

  // Additive fields appearing with API_VERSION 2026-01-09:
  output_text?: string | null
  parallel_tool_calls?: boolean
  previous_response_id?: string | null
  prompt_cache_retention?: string
  safety_identifier?: string
  service_tier?: "default" | string
  temperature?: number
  top_p?: number
  truncation?: "auto" | "disabled"
  tool_choice?: unknown
  tools?: Array<unknown>
  reasoning?: { effort?: string; summary?: unknown }
  text?: { format?: { type: string }; verbosity?: string }
  max_output_tokens?: number | null
  copilot_usage?: CopilotUsage
  copilot_info_messages?: Array<CopilotInfoMessage>
}
```

- [ ] **Step 3: Update `ResponsesMessageOutput`**

Replace the existing block with:

```ts
export interface ResponsesMessageOutput {
  type: "message"
  id: string
  status: "completed" | "in_progress"
  role: "assistant"
  phase?: string
  content: Array<
    | {
        type: "output_text"
        text: string
        annotations?: Array<unknown>
        logprobs?: Array<unknown>
      }
    | { type: "refusal"; refusal: string }
  >
}
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun test tests/translation-chat-to-responses.test.ts tests/responses-endpoint.test.ts tests/responses-routing.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/services/copilot/create-responses.ts
git commit -m "feat(types): align ResponsesResponse with Copilot 2026-01-09"
```

---

## Task 4: Fix `EmbeddingResponse` honesty

**Files:**
- Modify: `src/services/copilot/create-embeddings.ts`
- Modify: `src/routes/embeddings/route.ts`

- [ ] **Step 1: Make `object` / `model` optional**

In `src/services/copilot/create-embeddings.ts`, replace the existing `export interface EmbeddingResponse` block with:

```ts
export interface EmbeddingResponse {
  object?: string
  data: Array<Embedding>
  model?: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
```

- [ ] **Step 2: Drop the cast acrobatics in the route**

In `src/routes/embeddings/route.ts`, the existing handler casts the response back to `{ model?: string; usage?: ... }`. Now that the typed shape says the same thing, replace the body of the handler (the function body inside `embeddingRoutes.post("/", async (c) => { ... })`) with:

```ts
try {
  const payload = await c.req.json<EmbeddingRequest>()
  const response = await createEmbeddings(payload)

  recordUsage(c, {
    model: response.model ?? payload.model ?? null,
    promptTokens: response.usage?.prompt_tokens ?? null,
    completionTokens: null,
    totalTokens: response.usage?.total_tokens ?? null,
  })

  return c.json(response)
} catch (error) {
  return forwardError(c, error)
}
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun test` (full suite) — make sure nothing breaks.
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/services/copilot/create-embeddings.ts src/routes/embeddings/route.ts
git commit -m "fix(types): EmbeddingResponse honesty — object/model are optional upstream"
```

---

## Task 5: TDD — `captureInfoMessages` helper (failing test first)

**Files:**
- Create: `tests/copilot-info-messages.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/copilot-info-messages.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `bun test tests/copilot-info-messages.test.ts`
Expected: FAIL with `Cannot find module '../src/lib/copilot-info-messages'`.

---

## Task 6: Implement `copilot-info-messages.ts`

**Files:**
- Create: `src/lib/copilot-info-messages.ts`

- [ ] **Step 1: Write the implementation**

Create `src/lib/copilot-info-messages.ts`:

```ts
import consola from "consola"

import type { CopilotInfoMessage } from "~/services/copilot/types-shared"

const LEVEL: Record<string, "warn" | "info"> = {
  model_pending_deprecation: "warn",
}

const logged = new WeakSet<object>()

/**
 * Log upstream copilot_info_messages exactly once per source object and
 * return them so the caller can decide how to propagate.
 */
export function captureInfoMessages(
  source:
    | { copilot_info_messages?: Array<CopilotInfoMessage> }
    | undefined,
  ctx: { endpoint: string; model?: string | null },
): Array<CopilotInfoMessage> | undefined {
  if (!source?.copilot_info_messages?.length) return undefined
  if (logged.has(source)) return source.copilot_info_messages
  logged.add(source)

  for (const m of source.copilot_info_messages) {
    const level = LEVEL[m.code] ?? "info"
    consola[level](
      `[copilot:${m.code}] (${ctx.endpoint}${
        ctx.model ? ` model=${ctx.model}` : ""
      }) ${m.message}`,
    )
  }
  return source.copilot_info_messages
}

/**
 * Safely extract Copilot's per-request cost in nano-AIU. Returns null
 * when the field is absent, malformed, or zero (so callers can distinguish
 * "no data" from "real zero" by writing NULL into the database).
 */
export function pickCostNanoAiu(
  source: { copilot_usage?: { total_nano_aiu?: number } } | undefined,
): number | null {
  const v = source?.copilot_usage?.total_nano_aiu
  return typeof v === "number" && v > 0 ? v : null
}
```

- [ ] **Step 2: Run tests to confirm they pass**

Run: `bun test tests/copilot-info-messages.test.ts`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/copilot-info-messages.ts tests/copilot-info-messages.test.ts
git commit -m "feat(lib): captureInfoMessages + pickCostNanoAiu helpers"
```

---

## Task 7: Drizzle migration file + schema update

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0001_add_cost_nano_aiu.sql`
- Modify: `drizzle/meta/_journal.json` (drizzle-kit auto-updates)

- [ ] **Step 1: Add `costNanoAiu` to schema**

In `src/db/schema.ts`, replace the `requestLogs` table block with:

```ts
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authTokenId: integer("auth_token_id"),
    timestamp: integer("timestamp").notNull(),
    endpoint: text("endpoint").notNull(),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    statusCode: integer("status_code").notNull(),
    latencyMs: integer("latency_ms"),
    costNanoAiu: integer("cost_nano_aiu"),
  },
  (t) => ({
    tokenTsIdx: index("request_logs_token_ts_idx").on(
      t.authTokenId,
      t.timestamp,
    ),
    tsIdx: index("request_logs_ts_idx").on(t.timestamp),
  }),
)
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new file `drizzle/0001_*.sql` is created and `drizzle/meta/_journal.json` is updated.

- [ ] **Step 3: Verify the generated SQL**

Run: `ls drizzle/ | sort`
Expected: shows `0000_open_blob.sql` and a new `0001_<hash>.sql` (rename it if you want a friendlier name; see step 4).

Run: `cat drizzle/0001_*.sql`
Expected: contains `ALTER TABLE \`request_logs\` ADD \`cost_nano_aiu\` integer;`.

- [ ] **Step 4: (Optional) Rename for clarity**

If the generated filename is auto-suffixed (e.g. `0001_supreme_human_torch.sql`), rename it:

```bash
mv drizzle/0001_*.sql drizzle/0001_add_cost_nano_aiu.sql
```

Then update `drizzle/meta/_journal.json` — change the `tag` field of the new entry to `0001_add_cost_nano_aiu`.

- [ ] **Step 5: Verify tests still pass (in-memory test DB picks up new migration)**

Run: `bun test tests/usage-recorder.test.ts tests/queries-request-logs.test.ts`
Expected: green. `tests/helpers/test-db.ts` already calls `migrate(db, { migrationsFolder: "drizzle" })`, so the in-memory DB gets the new column automatically.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/0001_add_cost_nano_aiu.sql drizzle/meta/_journal.json
git commit -m "feat(db): add request_logs.cost_nano_aiu column + migration"
```

---

## Task 8: TDD — DB migration fail-fast wrapper (failing test first)

**Files:**
- Create: `tests/db-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db-migration.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { initDb, _setDbForTest } from "../src/db/client"
import * as schema from "../src/db/schema"
import { insertRequestLog } from "../src/db/queries/request-logs"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-db-test-"))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, "test.db")
}

describe("initDb migration", () => {
  test("fresh file is migrated to current schema (cost_nano_aiu exists)", () => {
    const p = tmpDbPath()
    initDb(p)

    const sqlite = new Database(p)
    const cols = sqlite
      .query(`PRAGMA table_info(request_logs)`)
      .all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain("cost_nano_aiu")
    sqlite.close()
  })

  test("idempotent: calling initDb twice does not error or duplicate work", () => {
    const p = tmpDbPath()
    initDb(p)
    initDb(p) // Should be a no-op as far as migrations go.

    const sqlite = new Database(p)
    const rows = sqlite
      .query(`SELECT count(*) AS c FROM __drizzle_migrations`)
      .all() as Array<{ c: number }>
    // Two migrations: 0000 + 0001.
    expect(rows[0]?.c).toBe(2)
    sqlite.close()
  })

  test("inserts can carry cost_nano_aiu after migration", async () => {
    const p = tmpDbPath()
    const db = initDb(p)
    _setDbForTest(db)
    await insertRequestLog({
      authTokenId: null,
      timestamp: Date.now(),
      endpoint: "/v1/chat/completions",
      statusCode: 200,
      costNanoAiu: 1_500_000,
    })
    const sqlite = new Database(p)
    const row = sqlite
      .query(`SELECT cost_nano_aiu FROM request_logs LIMIT 1`)
      .get() as { cost_nano_aiu: number | null }
    expect(row.cost_nano_aiu).toBe(1_500_000)
    sqlite.close()
  })
})
```

- [ ] **Step 2: Run the test — first assertion may already pass, but `insertRequestLog` with `costNanoAiu` will fail**

Run: `bun test tests/db-migration.test.ts`
Expected: the third test FAILS (`costNanoAiu` is not in `NewRequestLog` yet). The first two tests pass already because Task 7 wired schema + migration.

---

## Task 9: `NewRequestLog` and `insertRequestLog` accept `costNanoAiu`

**Files:**
- Modify: `src/db/queries/request-logs.ts`

- [ ] **Step 1: Extend `NewRequestLog`**

In `src/db/queries/request-logs.ts`, replace the existing `export interface NewRequestLog` with:

```ts
export interface NewRequestLog {
  authTokenId: number | null
  timestamp: number
  endpoint: string
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  costNanoAiu?: number | null
  statusCode: number
  latencyMs?: number | null
}
```

- [ ] **Step 2: Extend `insertRequestLog`**

Replace the existing `export async function insertRequestLog(input: NewRequestLog): Promise<void>` body's `db.insert(requestLogs).values(...)` call with the same shape plus the new column:

```ts
export async function insertRequestLog(input: NewRequestLog): Promise<void> {
  const db = getDb()
  await db.insert(requestLogs).values({
    authTokenId: input.authTokenId,
    timestamp: input.timestamp,
    endpoint: input.endpoint,
    model: input.model ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    costNanoAiu: input.costNanoAiu ?? null,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs ?? null,
  })
}
```

- [ ] **Step 3: Run the migration tests**

Run: `bun test tests/db-migration.test.ts`
Expected: all three tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/request-logs.ts tests/db-migration.test.ts
git commit -m "feat(db): insertRequestLog carries cost_nano_aiu"
```

---

## Task 10: `initDb` fail-fast wrapper + migrations folder resolver

**Files:**
- Modify: `src/db/client.ts`

- [ ] **Step 1: Add imports**

At the top of `src/db/client.ts`, replace the existing imports with:

```ts
import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import * as schema from "./schema"
```

- [ ] **Step 2: Rewrite `initDb` body to use the resolver and try/catch**

Replace the entire existing `export function initDb(...) { ... }` block with:

```ts
let db: BunSQLiteDatabase<typeof schema> | undefined

export function initDb(dbPath: string): BunSQLiteDatabase<typeof schema> {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.exec("PRAGMA journal_mode = WAL;")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  try {
    fs.chmodSync(dbPath, 0o600)
  } catch {
    /* ignore on systems that don't support chmod */
  }
  db = drizzle(sqlite, { schema })

  try {
    migrate(db, { migrationsFolder: resolveMigrationsFolder() })
  } catch (err) {
    consola.fatal("Database migration failed; refusing to start.", err)
    throw err
  }

  return db
}

/**
 * Find the drizzle migrations folder regardless of how the binary was
 * launched:
 *   - `bun run dev` → repo-root/drizzle
 *   - `bun dist/main.js` (packaged) → dist/drizzle (scripts/package.ts
 *     already copies the folder into the release tree).
 */
function resolveMigrationsFolder(): string {
  const here = import.meta.dir
  const bundled = path.join(here, "drizzle")
  if (fs.existsSync(bundled)) return bundled
  return path.join(here, "..", "..", "drizzle")
}
```

(Keep the existing `getDb` and `_setDbForTest` exports unchanged.)

- [ ] **Step 3: Add a fail-propagation test**

Append to `tests/db-migration.test.ts`:

```ts
import { mock } from "bun:test"
import * as migrator from "drizzle-orm/bun-sqlite/migrator"

describe("initDb fail-fast", () => {
  test("rethrows on migration failure", () => {
    const p = tmpDbPath()
    const orig = migrator.migrate
    const boom = new Error("synthetic migration failure")
    ;(migrator as { migrate: typeof migrator.migrate }).migrate = (() => {
      throw boom
    }) as never
    try {
      expect(() => initDb(p)).toThrow("synthetic migration failure")
    } finally {
      ;(migrator as { migrate: typeof migrator.migrate }).migrate = orig
    }
  })
})
```

- [ ] **Step 4: Verify**

Run: `bun test tests/db-migration.test.ts`
Expected: all four tests PASS.

Run: `bun test` (full suite — make sure nothing else broke)
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/db/client.ts tests/db-migration.test.ts
git commit -m "feat(db): fail-fast migration + dev/packaged folder resolver"
```

---

## Task 11: TDD — usage-recorder carries `costNanoAiu` and tracks `/v1/responses`

**Files:**
- Modify: `tests/usage-recorder.test.ts`

- [ ] **Step 1: Append the failing tests**

Append to the existing `describe("usage-recorder", () => { ... })` block (inside the closing `})`):

```ts
test("records cost_nano_aiu when supplied to recordUsage", async () => {
  const id = await createAuthToken({
    name: "u",
    tokenHash: "h2",
    tokenPrefix: "p2",
  })
  const app = new Hono()
  app.use(async (c, next) => {
    c.set("authTokenId", id)
    await next()
  })
  app.use(usageRecorder())
  app.post("/v1/chat/completions", async (c) => {
    await recordUsage(c, {
      promptTokens: 14,
      completionTokens: 9,
      totalTokens: 23,
      costNanoAiu: 1_500_000,
      model: "gpt-4o-mini",
    })
    return c.json({ ok: true })
  })
  const res = await app.request("/v1/chat/completions", { method: "POST" })
  expect(res.status).toBe(200)
  const logs = await recentLogs({ tokenId: id, limit: 1 })
  expect(logs[0]?.costNanoAiu).toBe(1_500_000)
})

test("/v1/responses is tracked as a billable endpoint", async () => {
  const id = await createAuthToken({
    name: "u",
    tokenHash: "h3",
    tokenPrefix: "p3",
  })
  const app = new Hono()
  app.use(async (c, next) => {
    c.set("authTokenId", id)
    await next()
  })
  app.use(usageRecorder())
  app.post("/v1/responses", async (c) => {
    await recordUsage(c, {
      promptTokens: 5,
      totalTokens: 12,
      costNanoAiu: 999_000,
    })
    return c.json({ ok: true })
  })
  const res = await app.request("/v1/responses", { method: "POST" })
  expect(res.status).toBe(200)
  const logs = await recentLogs({ tokenId: id, limit: 1 })
  expect(logs).toHaveLength(1)
  expect(logs[0]?.endpoint).toBe("/v1/responses")
  expect(logs[0]?.costNanoAiu).toBe(999_000)
})
```

Note: this also requires `recentLogs()` to return `costNanoAiu`. Check `src/db/queries/request-logs.ts:90` (the `recentLogs` function) — if its `RecentLog` interface doesn't expose `costNanoAiu` yet, add the field there too. See Task 12 step 2.

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test tests/usage-recorder.test.ts`
Expected: both new tests FAIL because:
1. `recordUsage` does not accept `costNanoAiu` yet.
2. `/v1/responses` is not in `TRACKED_ENDPOINT_PREFIXES`.

---

## Task 12: Make usage-recorder accept `costNanoAiu` and track `/v1/responses`

**Files:**
- Modify: `src/lib/usage-recorder.ts`
- Modify: `src/db/queries/request-logs.ts` (only if `recentLogs` interface needs `costNanoAiu`)

- [ ] **Step 1: Extend `PendingUsage`, `recordUsage`, `writeLogInner`**

In `src/lib/usage-recorder.ts`:

(a) Locate the `interface PendingUsage` block and add `costNanoAiu?: number | null`:

```ts
interface PendingUsage {
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  costNanoAiu?: number | null
  model?: string | null
  recorded?: boolean
  billable?: boolean
}
```

(b) Locate the `TRACKED_ENDPOINT_PREFIXES` array (around line 30) and add the `/responses` entries:

```ts
const TRACKED_ENDPOINT_PREFIXES = [
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/messages",
  "/v1/embeddings",
  "/embeddings",
  "/v1/responses",
  "/responses",
] as const
```

(c) In `recordUsage`, replace the body to include the new field:

```ts
export function recordUsage(
  c: Context,
  data: Pick<
    PendingUsage,
    | "promptTokens"
    | "completionTokens"
    | "totalTokens"
    | "costNanoAiu"
    | "model"
    | "billable"
  >,
): void {
  const p = getPending(c)
  if (data.promptTokens !== undefined) p.promptTokens = data.promptTokens
  if (data.completionTokens !== undefined)
    p.completionTokens = data.completionTokens
  if (data.totalTokens !== undefined) p.totalTokens = data.totalTokens
  if (data.costNanoAiu !== undefined) p.costNanoAiu = data.costNanoAiu
  if (data.model !== undefined) p.model = data.model
  if (data.billable !== undefined) p.billable = data.billable
}
```

(d) In `writeLogInner`, add `costNanoAiu` to the `insertRequestLog` call:

```ts
await insertRequestLog({
  authTokenId: tokenId,
  timestamp: ts,
  endpoint,
  model: pending.model ?? null,
  promptTokens: pending.promptTokens ?? null,
  completionTokens: pending.completionTokens ?? null,
  totalTokens: pending.totalTokens ?? null,
  costNanoAiu: pending.costNanoAiu ?? null,
  statusCode: status,
  latencyMs: ts - startedAt,
})
```

- [ ] **Step 2: Ensure `recentLogs` exposes `costNanoAiu`**

Open `src/db/queries/request-logs.ts:90` and inspect the `recentLogs` function and its `RecentLog` interface. If `costNanoAiu` (or `cost_nano_aiu`) is missing from the SELECT/return shape, extend both:

(a) Add `costNanoAiu: number | null` to the existing `RecentLog` interface.

(b) Update the SELECT call so the returned row has `costNanoAiu: row.cost_nano_aiu` (or the drizzle equivalent if it's using the schema map directly).

(If `recentLogs` returns the row via `db.select().from(requestLogs)`, drizzle will include `costNanoAiu` automatically — only the interface needs updating.)

- [ ] **Step 3: Run tests to confirm they pass**

Run: `bun test tests/usage-recorder.test.ts`
Expected: all tests PASS, including the two new ones.

- [ ] **Step 4: Commit**

```bash
git add src/lib/usage-recorder.ts src/db/queries/request-logs.ts tests/usage-recorder.test.ts
git commit -m "feat(usage): track cost_nano_aiu and /v1/responses requests"
```

---

## Task 13: Wire cost capture into `/v1/chat/completions` (non-stream + stream)

**Files:**
- Modify: `src/routes/chat-completions/handler.ts`

- [ ] **Step 1: Add helper imports**

Insert near the existing imports at the top of the file:

```ts
import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
```

- [ ] **Step 2: Non-streaming path — capture info_messages and pass cost**

Locate the non-streaming branch (where the handler returns `c.json(...)` for a single `ChatCompletionResponse`). The current body roughly looks like:

```ts
recordUsage(c, {
  model: ...,
  promptTokens: response.usage?.prompt_tokens ?? null,
  completionTokens: response.usage?.completion_tokens ?? null,
  totalTokens: response.usage?.total_tokens ?? null,
})
return c.json(response)
```

Replace the `recordUsage` call with the cost-aware variant, and add the capture line **above** it:

```ts
captureInfoMessages(response, {
  endpoint: "/v1/chat/completions",
  model: response.model ?? null,
})
recordUsage(c, {
  model: response.model ?? null,
  promptTokens: response.usage?.prompt_tokens ?? null,
  completionTokens: response.usage?.completion_tokens ?? null,
  totalTokens: response.usage?.total_tokens ?? null,
  costNanoAiu: pickCostNanoAiu(response),
})
return c.json(response)
```

- [ ] **Step 3: Streaming path — accumulate cost across chunks**

Locate the streaming branch where chunks are consumed (`for await (const chunk of response) { ... }` or via `events()` iteration). Identify where `usage.prompt`, `usage.completion`, `usage.total` are accumulated. Add a parallel accumulator and a capture call:

(a) At the top of the streaming handler (alongside existing locals), add:

```ts
let costNanoAiu: number | null = null
```

(b) Inside the chunk loop, after parsing `chunk` (typed as `ChatCompletionChunk`), add:

```ts
if (chunk.copilot_info_messages?.length) {
  captureInfoMessages(chunk, {
    endpoint: "/v1/chat/completions",
    model: chunk.model ?? null,
  })
}
const c2 = pickCostNanoAiu(chunk)
if (c2 !== null) costNanoAiu = c2
```

(c) In the `finally` block, when `recordUsage` is called with `promptTokens`/`completionTokens`/`totalTokens`, also pass `costNanoAiu: costNanoAiu`. Locate the existing `recordUsage(c, { ... })` call inside `finally` and add the field:

```ts
recordUsage(c, {
  promptTokens: usage.prompt || null,
  completionTokens: usage.completion || null,
  totalTokens: usage.total || null,
  costNanoAiu: costNanoAiu,
  model: ...,
})
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun test tests/create-chat-completions.test.ts tests/usage-recorder.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/chat-completions/handler.ts
git commit -m "feat(chat): capture info_messages and cost into usage-recorder"
```

---

## Task 14: Wire cost capture into `/v1/responses` (non-stream + stream)

**Files:**
- Modify: `src/routes/responses/handler.ts`

- [ ] **Step 1: Add imports**

```ts
import { recordUsage } from "~/lib/usage-recorder"
import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
import type { ResponsesResponse } from "~/services/copilot/create-responses"
```

- [ ] **Step 2: Non-streaming path**

Locate the non-streaming `return c.json(upstream)` branch at the bottom of the handler. **Just above** that `return`, insert:

```ts
const resp = upstream as ResponsesResponse
captureInfoMessages(resp, {
  endpoint: "/v1/responses",
  model: resp.model ?? null,
})
recordUsage(c, {
  model: resp.model ?? null,
  promptTokens: resp.usage?.input_tokens ?? null,
  completionTokens: resp.usage?.output_tokens ?? null,
  totalTokens: resp.usage?.total_tokens ?? null,
  costNanoAiu: pickCostNanoAiu(resp),
})
```

- [ ] **Step 3: Streaming path**

Inside the existing `for await (const evt of upstream as AsyncIterable<...>) { ... }` loop, just before the existing `if (evt.id !== undefined) controller.enqueue(...)` block, add log + cost capture:

```ts
if (evt.event === "response.completed" && evt.data) {
  try {
    const parsed = JSON.parse(evt.data) as {
      response?: ResponsesResponse
    }
    if (parsed.response) {
      captureInfoMessages(parsed.response, {
        endpoint: "/v1/responses",
        model: parsed.response.model ?? null,
      })
      const cost = pickCostNanoAiu(parsed.response)
      if (cost !== null) streamCost = cost
      streamUsage.input = parsed.response.usage?.input_tokens ?? streamUsage.input
      streamUsage.output =
        parsed.response.usage?.output_tokens ?? streamUsage.output
      streamUsage.total =
        parsed.response.usage?.total_tokens ?? streamUsage.total
      streamModel = parsed.response.model ?? streamModel
    }
  } catch {
    /* best-effort; never break pass-through on parse failure */
  }
}
```

At the **top** of the streaming branch (before opening the `new Response(new ReadableStream(...))`), declare:

```ts
let streamCost: number | null = null
let streamModel: string | null = null
const streamUsage = { input: 0, output: 0, total: 0 }
```

After the `controller.close()` in the `finally` of the ReadableStream's `start()`, the stream consumer is done — but we are still inside the `await fetch(...)` lifecycle of the Hono handler. To make `recordUsage` actually fire when the stream ends, defer to the usage-recorder middleware:

Wrap the ReadableStream `start()` `finally` block to call `recordUsage`:

```ts
} finally {
  c.req.raw.signal.removeEventListener("abort", onAbort)
  recordUsage(c, {
    model: streamModel,
    promptTokens: streamUsage.input || null,
    completionTokens: streamUsage.output || null,
    totalTokens: streamUsage.total || null,
    costNanoAiu: streamCost,
  })
  controller.close()
}
```

(Place the `recordUsage` call before `controller.close()` so the data is committed to context before the response stream completes.)

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun test tests/responses-endpoint.test.ts tests/responses-routing.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "feat(responses): capture info_messages and cost into usage-recorder"
```

---

## Task 15: TDD — Anthropic non-stream mounts `copilot_info_messages`

**Files:**
- Modify: `tests/anthropic-response.test.ts`

- [ ] **Step 1: Append failing test cases**

At the end of the existing `describe("translateToAnthropic", () => { ... })` block (or top-level describe in the file, whichever wraps `translateToAnthropic` cases), add:

```ts
test("does not add copilot_info_messages when upstream omits it", () => {
  const openAIResponse: ChatCompletionResponse = {
    id: "chatcmpl-x",
    model: "claude-sonnet-4.5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
  }
  const out = translateToAnthropic(openAIResponse)
  expect(out).not.toHaveProperty("copilot_info_messages")
})

test("mounts copilot_info_messages verbatim when present", () => {
  const openAIResponse: ChatCompletionResponse = {
    id: "chatcmpl-x",
    model: "claude-sonnet-4.5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    copilot_info_messages: [
      { code: "model_pending_deprecation", message: "Sonnet 4 deprecates soon" },
    ],
  }
  const out = translateToAnthropic(openAIResponse) as typeof openAIResponse & {
    copilot_info_messages?: unknown
  }
  expect(out.copilot_info_messages).toEqual([
    { code: "model_pending_deprecation", message: "Sonnet 4 deprecates soon" },
  ])
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test tests/anthropic-response.test.ts`
Expected: the "mounts copilot_info_messages" test FAILS — current translator returns an object without that field.

---

## Task 16: Mount `copilot_info_messages` in Anthropic translator + types

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts`
- Modify: `src/routes/messages/non-stream-translation.ts`

- [ ] **Step 1: Add field to `AnthropicResponse`**

In `src/routes/messages/anthropic-types.ts`, at the top of the file (under the existing `// Anthropic API Types` comment), add an import:

```ts
import type { CopilotInfoMessage } from "~/services/copilot/types-shared"
```

Then replace the existing `export interface AnthropicResponse { ... }` block with the same body plus one optional field at the end:

```ts
export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
  }
  copilot_info_messages?: Array<CopilotInfoMessage>
}
```

Also extend `AnthropicStreamState` (further down the same file) — add an optional field:

```ts
export interface AnthropicStreamState {
  // ...all existing fields unchanged
  copilotInfoMessages?: Array<CopilotInfoMessage>
}
```

And declare the new event type (anywhere near the other event interfaces):

```ts
export interface AnthropicCopilotInfoEvent {
  type: "copilot_info"
  messages: Array<CopilotInfoMessage>
}
```

- [ ] **Step 2: Mount field in `translateToAnthropic`**

In `src/routes/messages/non-stream-translation.ts`, find the `return { ... }` at the end of `translateToAnthropic`. Replace that `return` with a two-step build so we can conditionally attach the field:

```ts
const out: AnthropicResponse = {
  id: response.id,
  type: "message",
  role: "assistant",
  model: response.model,
  content: [...allTextBlocks, ...allToolUseBlocks],
  stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
  stop_sequence: null,
  usage: {
    input_tokens:
      (response.usage?.prompt_tokens ?? 0)
      - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    output_tokens: response.usage?.completion_tokens ?? 0,
    ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
      cache_read_input_tokens:
        response.usage.prompt_tokens_details.cached_tokens,
    }),
  },
}

if (response.copilot_info_messages?.length) {
  out.copilot_info_messages = response.copilot_info_messages
}

return out
```

- [ ] **Step 3: Verify**

Run: `bun test tests/anthropic-response.test.ts`
Expected: all tests PASS, including the two new ones.

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/anthropic-types.ts src/routes/messages/non-stream-translation.ts tests/anthropic-response.test.ts
git commit -m "feat(messages): mount copilot_info_messages on AnthropicResponse"
```

---

## Task 17: TDD — Anthropic stream emits `copilot_info` event

**Files:**
- Create: `tests/anthropic-stream-copilot-info.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/anthropic-stream-copilot-info.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"
import type { AnthropicStreamState } from "~/routes/messages/anthropic-types"
import { translateChunkToAnthropicEvents } from "~/routes/messages/stream-translation"

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

import { buildCopilotInfoEvent } from "~/routes/messages/stream-translation"

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
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test tests/anthropic-stream-copilot-info.test.ts`
Expected: FAIL — `buildCopilotInfoEvent` is not exported.

---

## Task 18: Implement `buildCopilotInfoEvent` and emit it from the stream handler

**Files:**
- Modify: `src/routes/messages/stream-translation.ts`
- Modify: `src/routes/messages/handler.ts`

- [ ] **Step 1: Add `buildCopilotInfoEvent` to stream-translation.ts**

Append to `src/routes/messages/stream-translation.ts`:

```ts
import type {
  AnthropicCopilotInfoEvent,
  AnthropicStreamState,
} from "./anthropic-types"

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
```

(If the file already has an `import` for `AnthropicStreamState`, extend it rather than duplicating the import line.)

- [ ] **Step 2: Run unit test to confirm pass**

Run: `bun test tests/anthropic-stream-copilot-info.test.ts`
Expected: both tests PASS.

- [ ] **Step 3: Wire the helper into the stream handler**

In `src/routes/messages/handler.ts`:

(a) Add imports (alongside existing imports from `./stream-translation` and `~/lib/copilot-info-messages`):

```ts
import {
  buildCopilotInfoEvent,
  translateChunkToAnthropicEvents,
} from "./stream-translation"
import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
```

(b) In the **non-streaming branch** (`if (isNonStreaming(response)) { ... }`), just before the existing `recordUsage(c, { ... })` call, add log + cost:

```ts
captureInfoMessages(response, {
  endpoint: "/v1/messages",
  model: openAIPayload.model,
})
recordUsage(c, {
  model: openAIPayload.model,
  promptTokens: response.usage?.prompt_tokens ?? null,
  completionTokens: response.usage?.completion_tokens ?? null,
  totalTokens: response.usage?.total_tokens ?? null,
  costNanoAiu: pickCostNanoAiu(response),
})
```

(Replace the existing `recordUsage` call rather than duplicating it.)

(c) In the **streaming branch** — inside `runAnthropicStream`, locate the `for await (const rawEvent of response) { ... }` loop where the chunk is parsed:

```ts
const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
```

Just after parsing the chunk, add (before `const events = translateChunkToAnthropicEvents(...)`):

```ts
if (chunk.copilot_info_messages?.length) {
  streamState.copilotInfoMessages = chunk.copilot_info_messages
  captureInfoMessages(chunk, {
    endpoint: "/v1/messages",
    model,
  })
}
const cc = pickCostNanoAiu(chunk)
if (cc !== null) streamCost = cc
```

(d) At the top of `runAnthropicStream`, declare the cost accumulator (alongside the existing `usage` object):

```ts
let streamCost: number | null = null
```

(e) In the `finally` block of `runAnthropicStream`, **before** the existing `await writeSafe("message_delta", { ... })` call, insert the copilot_info emission:

```ts
const copilotInfo = buildCopilotInfoEvent(streamState)
if (copilotInfo) {
  await writeSafe(copilotInfo.type, copilotInfo)
}
```

(f) In the same `finally` block, update the `recordUsage` call to include `costNanoAiu`:

```ts
recordUsage(c, {
  model,
  promptTokens: usage.prompt || null,
  completionTokens: usage.completion || null,
  totalTokens: usage.total || null,
  costNanoAiu: streamCost,
})
flushUsage(c)
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun test tests/anthropic-stream-copilot-info.test.ts tests/anthropic-response.test.ts tests/anthropic-request.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages/handler.ts src/routes/messages/stream-translation.ts tests/anthropic-stream-copilot-info.test.ts
git commit -m "feat(messages): emit copilot_info SSE event + track cost"
```

---

## Task 19: TDD + impl — embeddings handler tolerates missing `object`/`model`

**Files:**
- Create: `tests/embeddings-handler.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/embeddings-handler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { embeddingRoutes } from "../src/routes/embeddings/route"
import { state } from "../src/lib/state"
import { makeTestDb } from "./helpers/test-db"

const originalFetch = globalThis.fetch

beforeEach(() => {
  makeTestDb()
  state.copilotToken = "test-token"
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("embeddings handler", () => {
  test("succeeds when upstream omits top-level object and model", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
          ],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch

    const app = new Hono()
    app.route("/v1/embeddings", embeddingRoutes)
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "hi",
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ embedding: Array<number> }>
      usage: { prompt_tokens: number }
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3])
    expect(body.usage.prompt_tokens).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/embeddings-handler.test.ts`
Expected: PASS (Tasks 4 + the in-memory test DB from Task 7 already make this work; this test locks down the behavior so it doesn't regress).

- [ ] **Step 3: Commit**

```bash
git add tests/embeddings-handler.test.ts
git commit -m "test(embeddings): handler tolerates upstream omitting object/model"
```

---

## Task 20: Full-suite verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all tests PASS (existing + new).

- [ ] **Step 2: Typecheck and lint**

Run: `bun run typecheck`
Expected: 0 errors.

Run: `bun run lint`
Expected: 0 errors, no new warnings.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: succeeds.

Run: `ls dist/release/drizzle/ | sort`
Expected: shows `0000_open_blob.sql` **and** `0001_add_cost_nano_aiu.sql`.

- [ ] **Step 4: Manual smoke — fresh DB**

```bash
# Back up any existing local DB first if you care about its contents.
cp ~/.local/share/copilot-api/copilot-api.db ~/copilot-api.db.bak 2>/dev/null || true
rm -f ~/.local/share/copilot-api/copilot-api.db

bun run dev   # in another terminal
# In server logs, look for a line indicating migration applied (drizzle prints one).
sqlite3 ~/.local/share/copilot-api/copilot-api.db ".schema request_logs"
# Expected output contains:  `cost_nano_aiu` integer
```

- [ ] **Step 5: Manual smoke — hit each endpoint and inspect DB**

```bash
TOKEN=$(cat ~/.local/share/copilot-api/auth_token)
BASE=http://localhost:4141

curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  > /dev/null

curl -s "$BASE/v1/messages" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  > /dev/null

curl -s "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","input":"hi","stream":false}' \
  > /dev/null

curl -s "$BASE/v1/embeddings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"hi"}' \
  > /dev/null

sqlite3 ~/.local/share/copilot-api/copilot-api.db \
  "SELECT endpoint, model, total_tokens, cost_nano_aiu FROM request_logs ORDER BY id DESC LIMIT 4;"
# Expected:
#  /v1/embeddings|text-embedding-3-small|<n>|       (cost NULL)
#  /v1/responses|gpt-5.2-2025-12-11|<n>|<positive int>
#  /v1/messages|claude-sonnet-4.5|<n>|<positive int>
#  /v1/chat/completions|gpt-4o-mini-2024-07-18|<n>|<positive int>
```

- [ ] **Step 6: Manual smoke — `copilot_info_messages` flow**

```bash
# gpt-5.2 currently triggers model_pending_deprecation upstream.
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  | jq '.copilot_info_messages'
# Expected: a non-null array containing at least one entry with code "model_pending_deprecation".

curl -s "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","input":"hi","stream":false}' \
  | jq '.copilot_info_messages'
# Expected: same.
```

In the **server log**, look for lines like:

```
[copilot:model_pending_deprecation] (/v1/chat/completions model=gpt-5.2) GPT-5.2 has a planned deprecation date of 2026-06-01.
```

- [ ] **Step 7: Manual smoke — Anthropic stream `copilot_info` event**

Because Claude models don't currently trigger `copilot_info_messages` upstream, this is verified at unit-test level only (Task 17). To exercise it end-to-end, temporarily inject the field in a Bun REPL:

```bash
bun repl   # or `bun --eval "..."` if you prefer one-shot
```

Skip if Tasks 17 + 18 pass — the integration is covered.

- [ ] **Step 8: Confirm and stop the dev server**

If everything is green, the implementation is complete. Stop the dev server. Restore the backed-up DB file if desired:

```bash
cp ~/copilot-api.db.bak ~/.local/share/copilot-api/copilot-api.db
```

---

## Done criteria

- [ ] `bun test`, `bun run typecheck`, `bun run lint`, `bun run build` all green
- [ ] `dist/release/drizzle/0001_add_cost_nano_aiu.sql` present in build output
- [ ] Manual smoke writes `cost_nano_aiu` for chat / messages / responses requests (NULL for embeddings)
- [ ] Hitting `gpt-5.2` produces a server log line with `[copilot:model_pending_deprecation]`
- [ ] OpenAI clients see `copilot_info_messages` on chat/completion and responses bodies
- [ ] Anthropic clients see `copilot_info_messages` on the non-stream JSON response (when present) and ignore the new `event: copilot_info` SSE event without erroring

---

## Risk register (mirrors the spec)

| Risk | Mitigation |
|---|---|
| `drizzle/` path resolution fails after packaging | Task 10's `resolveMigrationsFolder` covers both layouts; Task 20 step 3 verifies the folder is shipped |
| `consola.warn` silenced in production | The helper falls back to `consola.info` for unknown codes; level can be tweaked later |
| `pickCostNanoAiu` misses a malformed upstream | Guard `typeof v === "number" && v > 0` covers strings, NaN, undefined, zero |
| Anthropic SDK starts rejecting unknown events | Cannot fully mitigate; non-stream path continues to surface `copilot_info_messages` |
| Migration partially applied | drizzle records success only on commit; next startup retries |
