# API Export Upgrade for Copilot API 2026-01-09

**Date:** 2026-05-22
**Status:** Draft (pending implementation)
**Trigger:** Commit `6dc9167` bumped `API_VERSION` from `2025-04-01` to `2026-01-09` and `COPILOT_VERSION` from `0.26.7` to `0.49.0`. Upstream now returns several new additive fields (`copilot_usage`, `copilot_info_messages`, `padding`, `reasoning_tokens`, `prompt_cache_retention`, etc.) that our exported API surface does not yet acknowledge.

## Goal

Bring the four exported endpoint families into alignment with the new upstream version **without breaking any existing client**:

| Endpoint | Method | Surface impact |
|---|---|---|
| `/v1/chat/completions` | POST | TS types completed; cost + info_messages flow through |
| `/v1/responses` | POST | TS types completed; cost + info_messages flow through (pass-through preserved) |
| `/v1/models` | GET | No change (already reshaped server-side) |
| `/v1/embeddings` | POST | `EmbeddingResponse` corrected to match reality |
| `/v1/messages` | POST | TS types completed; info_messages reach Anthropic clients via response field + custom SSE event |
| `/v1/messages/count_tokens` | POST | No change |

All changes are **additive and backward compatible** for both API consumers and the on-disk SQLite database.

## Non-Goals

- No dashboard / admin UI changes (cost lands in DB only).
- No new query APIs over `cost_nano_aiu` (data captured for future use).
- No changes to model listing transformation.
- No rollback story beyond "old code ignores the new column" (SQLite naturally tolerates this).
- No changes to upstream `/models` shape consumption (`Model` interface stays as-is).

## Decisions (locked)

- **Scope:** all 5 of the previously surfaced recommendations (type completion, info_messages capture+forward, cost-to-DB, EmbeddingResponse fix, Anthropic translator passthrough).
- **DB migration policy:** drizzle migration auto-applied on startup. **On migration failure: fail-fast** (`consola.fatal` + throw → process exits). No silent degradation.
- **"Smooth" definition:** user pulls the new version, starts the service, no manual command needed, no README to read.
- **`copilot_info_messages` destination:** server-log warn + non-streaming response passthrough + new streaming event (Anthropic side).
- **Cost destination:** `request_logs.cost_nano_aiu` only (no UI surface this round).

## Architecture Overview

```
                          ┌─────────────────────────────────────────┐
                          │  upstream Copilot API (2026-01-09)      │
                          │  New fields:                            │
                          │  · copilot_usage.total_nano_aiu         │
                          │  · copilot_info_messages[]              │
                          │  · padding / reasoning_tokens / ...     │
                          └────────────────┬────────────────────────┘
                                           │
       ┌───────────────────────────────────┼───────────────────────────────────┐
       │                                   │                                   │
       ▼                                   ▼                                   ▼
[services/copilot/*]              [routes/*/handler.ts]              [lib/usage-recorder.ts]
TS type completion (§2)           ① extract copilot_usage→cost       PendingUsage +
                                  ② extract copilot_info_messages       costNanoAiu (§4)
                                     → consola.warn  (§3)
                                     → forward / event (§3)
                                  ③ recordUsage(..., costNanoAiu)
                                                                                │
                                                                                ▼
                                                                       [db/schema.ts]
                                                                       request_logs
                                                                       + cost_nano_aiu (§4)
                                                                                │
                                                                                ▼
                                                                       [db/client.ts]
                                                                       initDb() drizzle
                                                                       migrate() on start
```

### Three invariants (used to bound every change)

1. **Zero break for old clients.** New response fields are all optional / additive. OpenAI and Anthropic SDKs both ignore unknown keys.
2. **Zero break for old DB files.** New columns are nullable. Existing rows get NULL. No semantic changes to existing columns.
3. **Zero break to stream frame ordering.** Existing `message_start → content_block_* → message_delta → message_stop` and `chat.completion.chunk` orders unchanged. `copilot_info_messages` is delivered through a single **new** event (Anthropic) or as a chunk field (OpenAI), never by mutating existing frames.

---

## §1 TS Type Completion

### 1.1 New shared type module — `src/services/copilot/types-shared.ts`

```ts
/**
 * Copilot per-request cost breakdown (nano-AIU units; 10^-9 AIU).
 * Stable starting with API_VERSION 2026-01-09.
 */
export interface CopilotUsage {
  token_details: Array<{
    batch_size: number       // typically 1_000_000
    cost_per_batch: number   // nano-AIU per batch for this token_type
    token_count: number
    token_type: "input" | "cache_read" | "cache_write" | "output" | string
  }>
  total_nano_aiu: number
}

/**
 * Out-of-band notifications from upstream. Known codes:
 *   - "model_pending_deprecation"
 * Open union for forward compatibility.
 */
export interface CopilotInfoMessage {
  code: "model_pending_deprecation" | string
  message: string
}
```

### 1.2 `ChatCompletionResponse` (delta only)

- `object` and `created` → **optional** (real responses omit them).
- `usage.reasoning_tokens?: number` — newly promoted to top level under `usage`.
- `usage.completion_tokens_details?` — new sub-object with `accepted_prediction_tokens` / `rejected_prediction_tokens`.
- `prompt_filter_results?: Array<{ prompt_index: number; content_filter_results: Record<string, unknown> }>` — new.
- `copilot_usage?: CopilotUsage` — new.
- `copilot_info_messages?: Array<CopilotInfoMessage>` — new.
- `ChoiceNonStreaming.content_filter_results?: Record<string, unknown>` — new.
- `ResponseMessage.padding?: string` — new (upstream BREACH-style filler).

### 1.3 `ChatCompletionChunk` (streaming, delta only)

- `object` → optional (chunks lack it).
- `prompt_filter_results?` — new (first chunk).
- `copilot_usage?` / `copilot_info_messages?` — new (last chunk).
- `Choice.content_filter_results?` — new.

### 1.4 `ResponsesResponse` (delta only)

Add as optional: `output_text`, `parallel_tool_calls`, `previous_response_id`, `prompt_cache_retention`, `safety_identifier`, `service_tier`, `temperature`, `top_p`, `truncation`, `tool_choice`, `tools`, `reasoning`, `text`, `max_output_tokens`, `copilot_usage`, `copilot_info_messages`.

`ResponsesMessageOutput.phase?: string` (e.g. `"final_answer"`).
`ResponsesMessageOutput.content[i].logprobs?: Array<unknown>` for `output_text` variant.

### 1.5 `EmbeddingResponse` correction

- `object` and `model` → **optional** (real responses omit both).

Side effect: the `anyResp as { model?: string ... }` cast acrobatics in `routes/embeddings/route.ts` can be removed.

### 1.6 `Model` interface — unchanged

Upstream `/models` shape evolution is unverified in this work; the reshape in `routes/models/route.ts` already isolates clients from it.

---

## §2 `copilot_info_messages` Handling

### 2.1 New helper — `src/lib/copilot-info-messages.ts`

```ts
import consola from "consola"
import type { CopilotInfoMessage } from "~/services/copilot/types-shared"

const LEVEL: Record<string, "warn" | "info"> = {
  model_pending_deprecation: "warn",
}

const logged = new WeakSet<object>()

export function captureInfoMessages(
  source: { copilot_info_messages?: Array<CopilotInfoMessage> } | undefined,
  ctx: { endpoint: string; model?: string | null },
): Array<CopilotInfoMessage> | undefined {
  if (!source?.copilot_info_messages?.length) return undefined
  if (logged.has(source)) return source.copilot_info_messages
  logged.add(source)

  for (const m of source.copilot_info_messages) {
    const level = LEVEL[m.code] ?? "info"
    consola[level](
      `[copilot:${m.code}] (${ctx.endpoint}${ctx.model ? ` model=${ctx.model}` : ""}) ${m.message}`,
    )
  }
  return source.copilot_info_messages
}

export function pickCostNanoAiu(
  source: { copilot_usage?: { total_nano_aiu?: number } } | undefined,
): number | null {
  const v = source?.copilot_usage?.total_nano_aiu
  return typeof v === "number" && v > 0 ? v : null
}
```

WeakSet ensures the same response object is not logged twice if `captureInfoMessages` is called from both the handler and the translator.

### 2.2 `/v1/chat/completions`

- **Non-streaming**: `captureInfoMessages(response, …)` for logging; the response object itself already carries `copilot_info_messages`, so `c.json(response)` passes it through verbatim.
- **Streaming**: in the chunk loop, when a chunk carries `copilot_info_messages`, call `captureInfoMessages(chunk, …)`. Chunk is forwarded as-is to the client — OpenAI's `data:` frame is a free-form JSON, unknown keys are kept.

### 2.3 `/v1/responses`

- **Non-streaming**: `captureInfoMessages(upstream, …)` then `c.json(upstream)`. Pass-through preserved.
- **Streaming**: byte-level pass-through unchanged. The stream loop additionally peeks at events named `response.completed`, parses `data` JSON, and runs `captureInfoMessages(parsed.response, …)` for logging. Parse errors are swallowed (logging is best-effort and must never break pass-through).

### 2.4 `/v1/messages` (Anthropic)

**Non-streaming**

`translateToAnthropic()` learns to mount `copilot_info_messages` onto its result when present:

```ts
if (response.copilot_info_messages?.length) {
  out.copilot_info_messages = response.copilot_info_messages
}
```

`AnthropicResponse` in `anthropic-types.ts` adds an optional field `copilot_info_messages?: Array<CopilotInfoMessage>`.

**Streaming**

New custom SSE event between `content_block_stop` and `message_delta`:

```
event: message_start          ← unchanged
event: content_block_start    ← unchanged
event: content_block_delta    ← unchanged (multiple)
event: content_block_stop     ← unchanged
event: copilot_info           ← NEW (only when messages exist)
event: message_delta          ← unchanged
event: message_stop           ← unchanged
```

Event payload:

```json
{ "type": "copilot_info", "messages": [ { "code": "...", "message": "..." } ] }
```

`AnthropicStreamState` gains an optional `copilotInfoMessages?: Array<CopilotInfoMessage>` field; the stream loop populates it when it sees the field on an inbound chunk; the `finally` block emits the event before `message_delta` is written.

**Why a new event vs. metadata-on-existing-event:** the Anthropic protocol has no official field for model-deprecation; piggybacking on `message_delta.metadata` would still be a private extension and would require computing it before the last chunk arrives. A standalone event is cleaner, and Anthropic SDK's stream parser ignores unknown event types (verified behavior).

### 2.5 Compatibility validation

| Client | Behavior |
|---|---|
| OpenAI SDK (chat completions) | Unknown top-level keys ignored; downstream code can read `chunk.copilot_info_messages` if it wants. |
| Anthropic SDK (`@anthropic-ai/sdk`) | Unknown `event: copilot_info` falls into the parser's default branch → skipped → does not block `message_stop`. |
| Claude Code | Same as Anthropic SDK. |

---

## §3 Cost Persistence + Smooth DB Migration

### 3.1 Schema change — `src/db/schema.ts`

```ts
export const requestLogs = sqliteTable(
  "request_logs",
  {
    // ...existing columns unchanged
    costNanoAiu: integer("cost_nano_aiu"),   // NEW, nullable
  },
  // ...existing indexes unchanged
)
```

Rationale:

- `INTEGER` — SQLite variable-width 1–8 bytes, ample for nano-AIU magnitudes (~10^7 in sampled responses).
- **Nullable, no DEFAULT 0** — preserves the distinction between "no data" (NULL) and "zero cost" (0).
- No new index this round (no queries yet).

### 3.2 Migration file — `drizzle/0001_add_cost_nano_aiu.sql`

Generated via `bun run db:generate`; expected SQL:

```sql
ALTER TABLE `request_logs` ADD `cost_nano_aiu` integer;
```

`drizzle/meta/_journal.json` gets a new entry automatically. SQLite `ALTER TABLE ADD COLUMN` with a nullable type is O(1) (header-only change), so old DBs with millions of rows upgrade in milliseconds.

### 3.3 Startup migration — `src/db/client.ts`

**Current state** (already in the file):

```ts
export function initDb(dbPath: string): BunSQLiteDatabase<typeof schema> {
  // …open file, set pragmas…
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: "drizzle" })  // ← already here, no error handling
  return db
}
```

So drizzle migrate is **already** invoked on startup. What this spec changes:

1. Wrap the `migrate()` call in `try / catch`, log via `consola.fatal`, and rethrow so the process exits visibly:

   ```ts
   try {
     migrate(db, { migrationsFolder: resolveMigrationsFolder() })
   } catch (err) {
     consola.fatal("Database migration failed; refusing to start.", err)
     throw err
   }
   ```

2. Replace the hard-coded `"drizzle"` (cwd-relative — fragile under packaged deployment) with a resolver that finds the folder regardless of how the binary is launched:

   ```ts
   function resolveMigrationsFolder(): string {
     const here = import.meta.dir
     const bundled = path.join(here, "drizzle")     // dist/drizzle after packaging
     if (fs.existsSync(bundled)) return bundled
     return path.join(here, "..", "..", "drizzle") // repo-root drizzle in dev
   }
   ```

`initDb` stays **synchronous** (matching its existing signature) — `drizzle-orm/bun-sqlite/migrator`'s `migrate()` is synchronous on bun-sqlite, no async refactor needed at call sites (`src/start.ts:63`).

Drizzle uses its own `__drizzle_migrations` table to track applied hashes, so `migrate()` is idempotent — already-applied migrations are skipped.

### 3.4 `usage-recorder` plumbing

- `PendingUsage` gains `costNanoAiu?: number | null`.
- `recordUsage(c, data)` accepts a new optional `costNanoAiu` key. All existing call sites continue to work unchanged.
- `writeLogInner()` passes `pending.costNanoAiu ?? null` to `insertRequestLog`.
- `NewRequestLog` interface and `insertRequestLog` (in `src/db/queries/request-logs.ts`) add the column.
- `TRACKED_ENDPOINT_PREFIXES` gains `/v1/responses` and `/responses` so that responses endpoint requests get a `request_logs` row.

`countRequestsSince` / `sumTokensSince` are **not** modified — this round writes only.

### 3.5 Wiring the four handlers

| Handler | Source of cost | Action |
|---|---|---|
| `routes/chat-completions/handler.ts` (non-stream) | `response.copilot_usage.total_nano_aiu` | `recordUsage(c, { …, costNanoAiu: pickCostNanoAiu(response) })` |
| `routes/chat-completions/handler.ts` (stream) | chunk with `copilot_usage` (typically final chunk) | accumulate during loop, pass to `recordUsage` in `finally` |
| `routes/messages/handler.ts` | upstream OpenAI shape (Anthropic translation), same as chat | same as above |
| `routes/responses/handler.ts` (non-stream) | `upstream.copilot_usage.total_nano_aiu` | `recordUsage(c, { …, costNanoAiu: pickCostNanoAiu(upstream) })` |
| `routes/responses/handler.ts` (stream) | `response.completed` event's parsed JSON | reuse §2.3 parse; pass cost to `recordUsage` |
| `routes/embeddings/route.ts` | n/a (upstream omits `copilot_usage`) | leave `costNanoAiu` unset → NULL |

### 3.6 Compatibility matrix

| Scenario | Result |
|---|---|
| New code + old DB (no `cost_nano_aiu` column) | Migration adds column on startup; old rows NULL. |
| New code + new DB | Normal. |
| **User rolls back to old code with new DB** | Old code does not read or write the new column; SQLite ignores unknown columns. ✓ |
| Upstream omits `copilot_usage` (older API path, failed request, embeddings) | `pickCostNanoAiu` returns `null`; row written with `cost_nano_aiu = NULL`. |
| Migration fails | `consola.fatal` + throw → process exits. User sees the error immediately. |

### 3.7 Packaging

`scripts/package.ts` already produces `dist/release/drizzle/` (verified from the working tree). The new `0001_add_cost_nano_aiu.sql` + updated `_journal.json` will be picked up automatically. Verified at build time during §4.

---

## §4 Testing Strategy

### 4.1 TDD (unit / integration)

**a) Type completion (§1)** — no dedicated tests; verified via `bun run typecheck`. Fixtures in existing tests get one additional sample (e.g. a `padding` field on a chat fixture) so narrow logic stays exercised.

**b) Embedding handler with shape-correct response** — new `tests/embeddings-handler.test.ts`. Mock upstream returns a body with no `object` and no `model`; handler must still return 200 and surface a model name (from the request payload) without runtime cast acrobatics.

**c) `captureInfoMessages` (§2.1)** — new `tests/copilot-info-messages.test.ts`:
- `undefined` source → no-op, no log.
- Known code → `consola.warn` called once, returns array.
- Unknown code → `consola.info` (not warn).
- Same source passed twice → log only once (WeakSet idempotency).

**d) `pickCostNanoAiu` (§2.1)** — same test file:
- `undefined`, `{}`, `{ copilot_usage: { total_nano_aiu: 0 } }` → all return `null`.
- Positive number → returned as-is.

**e) Anthropic non-stream translation mount (§2.4)** — extend `tests/anthropic-response.test.ts`:
- Response without `copilot_info_messages` → translated output **lacks** that key.
- Response with `copilot_info_messages` → translated output contains the array verbatim.

**f) Anthropic stream `event: copilot_info` injection (§2.4)** — new `tests/anthropic-stream-copilot-info.test.ts`:
- Mock upstream async iterable; last chunk carries `copilot_info_messages`.
- Run the stream loop; capture emitted events.
- Assert: `copilot_info` appears **after** `content_block_stop` and **before** `message_delta`.
- Upstream without info_messages → no `copilot_info` event emitted.

**g) `usage-recorder` writes cost (§3.4)** — extend `tests/usage-recorder.test.ts`:
- `recordUsage(c, { costNanoAiu: 1500000 })` + `flushUsage` → `insertRequestLog` called with `costNanoAiu: 1500000`.
- Default path → `costNanoAiu: null`.

**h) DB migration (§3.1–3.3)** — new `tests/db-migration.test.ts`:
1. **Forward migration:** create a fresh SQLite file, run raw SQL to materialize the **pre-0001** schema (i.e. apply `drizzle/0000_open_blob.sql` contents directly, and stamp `__drizzle_migrations` with only the 0000 hash). Insert a couple of dummy rows into `request_logs`. Then call `initDb(path)`. Assert: `PRAGMA table_info(request_logs)` shows `cost_nano_aiu`; old rows have NULL there; new inserts can carry a value.
2. **Idempotency:** call `initDb(path)` twice in a row — no error, no duplicate work (`__drizzle_migrations` row count unchanged after second call).
3. **Failure propagation:** mock `migrate()` (via a thin wrapper module that the test substitutes) to throw — assert `initDb` rethrows and `consola.fatal` is called once.

**i) `/v1/responses` joins usage tracking (§3.4)** — extend `tests/usage-recorder.test.ts`:
- Simulate a request to `/v1/responses` → `TRACKED_ENDPOINT_PREFIXES` matches → row written.

### 4.2 Manual smoke (one live server run)

```bash
# Old-DB upgrade path
cp <old-db-backup> ~/.local/share/copilot-api/copilot-api.db
bun run start -- --no-auth
# Expect log line indicating migration applied.
sqlite3 ~/.local/share/copilot-api/copilot-api.db ".schema request_logs"
# Expect cost_nano_aiu in output.

# Hit all four endpoints
TOKEN=...
curl -s http://localhost:4141/v1/chat/completions -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{...gpt-4o-mini...}'
curl -s http://localhost:4141/v1/messages -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{...claude...}'
curl -s http://localhost:4141/v1/responses -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{...gpt-5.2...}'
curl -s http://localhost:4141/v1/embeddings -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{...text-embedding-3-small...}'

sqlite3 ~/.local/share/copilot-api/copilot-api.db \
  "SELECT endpoint, model, total_tokens, cost_nano_aiu FROM request_logs ORDER BY id DESC LIMIT 4;"
# Expect: chat / messages / responses rows have non-null cost; embeddings row NULL.

# info_messages flow (use gpt-5.2 to trigger model_pending_deprecation)
curl -s http://localhost:4141/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  | jq '.copilot_info_messages'
# Expect non-null array.

# Server log should contain:
#   [copilot:model_pending_deprecation] (/v1/chat/completions model=gpt-5.2) ...
```

### 4.3 Required green checks before declaring done

```bash
bun run typecheck          # 0 errors
bun run lint               # 0 errors, no new warnings
bun test                   # all existing + new tests pass
bun run build              # successful, drizzle/ ends up in dist/
ls dist/release/drizzle/ | grep 0001   # new migration is shipped
```

### 4.4 Out of scope for tests

- Dashboard / admin UI surfaces (not changed).
- `/v1/responses` stream custom events (we do not add any; byte pass-through retained).
- Rollback path (old code + new DB) — relies on SQLite's ignore-unknown-column semantics.
- Cross-platform migration folder resolution — covered by §4.2 smoke.

### 4.5 Risk register

| Risk | Trigger | Mitigation |
|---|---|---|
| `drizzle/` path resolution fails after packaging | User runs `dist/main.js` directly | §4.2 smoke; fallback: inline migrations as string constants. |
| `consola.warn` silenced in production | NODE_ENV controls level | Use `consola.info` as fallback; consider `console.warn` if necessary. |
| `pickCostNanoAiu` misses a shape (e.g. nano-AIU as a string) | Upstream variability | `typeof v === "number" && v > 0` guard. |
| Anthropic SDK starts rejecting unknown events | Upstream SDK behavior change | Cannot fully mitigate; degrade gracefully — non-stream path still surfaces `copilot_info_messages`. |
| Migration partially applied | Extremely unlikely; SQLite ALTER is atomic | drizzle records success only on commit; next startup retries. |

---

## File-level Change Inventory

| File | Change |
|---|---|
| `src/services/copilot/types-shared.ts` | **NEW** — `CopilotUsage`, `CopilotInfoMessage`. |
| `src/services/copilot/create-chat-completions.ts` | Type augmentation (§1.2, §1.3). |
| `src/services/copilot/create-responses.ts` | Type augmentation (§1.4). |
| `src/services/copilot/create-embeddings.ts` | `object` / `model` → optional (§1.5). |
| `src/lib/copilot-info-messages.ts` | **NEW** — `captureInfoMessages`, `pickCostNanoAiu`. |
| `src/routes/chat-completions/handler.ts` | Capture info_messages + cost in both paths. |
| `src/routes/messages/handler.ts` | Capture info_messages + cost; stream emits `copilot_info` event. |
| `src/routes/messages/non-stream-translation.ts` | Mount `copilot_info_messages` on output when present. |
| `src/routes/messages/anthropic-types.ts` | Add field to `AnthropicResponse`, add `AnthropicCopilotInfoEvent`, extend `AnthropicStreamState`. |
| `src/routes/responses/handler.ts` | Non-stream: capture info_messages + cost. Stream: parse `response.completed` for logging + cost. Both add `recordUsage` calls. |
| `src/routes/embeddings/route.ts` | Drop cast acrobatics (type is now honest). |
| `src/db/schema.ts` | Add `costNanoAiu`. |
| `src/db/queries/request-logs.ts` | `NewRequestLog` and `insertRequestLog` add the column. |
| `src/db/client.ts` | `initDb()` invokes `migrate()`; fails fast. |
| `src/lib/usage-recorder.ts` | `PendingUsage`, `recordUsage`, `writeLogInner` carry `costNanoAiu`; track `/v1/responses`. |
| `drizzle/0001_add_cost_nano_aiu.sql` | **NEW** — drizzle-generated. |
| `drizzle/meta/_journal.json` | Updated by drizzle-kit. |
| `tests/copilot-info-messages.test.ts` | **NEW**. |
| `tests/anthropic-stream-copilot-info.test.ts` | **NEW**. |
| `tests/embeddings-handler.test.ts` | **NEW**. |
| `tests/db-migration.test.ts` | **NEW**. |
| `tests/anthropic-response.test.ts` | Extended cases for info_messages mount. |
| `tests/usage-recorder.test.ts` | Extended cases for cost field + `/v1/responses` tracking. |

## Open Questions

None at brainstorm time; user has approved all section-level designs. Any new questions surfaced during implementation should be raised before deviating from this spec.
