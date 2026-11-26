import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import {
  createAuthToken,
  getAuthTokenById,
} from "../src/db/queries/auth-tokens"
import {
  insertRequestLog,
  pruneOldLogs,
  recentLogs,
} from "../src/db/queries/request-logs"
import { createSession } from "../src/db/queries/sessions"
import { hashToken } from "../src/lib/auth-token-utils"
import { resetResponsesRouting } from "../src/lib/responses-routing"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import { makeTestDb } from "./helpers/test-db"

const realFetch = globalThis.fetch
const originalState = { ...state }

function makeModel(
  id: string,
  vendor: string,
  endpoints: Array<string>,
): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor,
    version: id,
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {},
      supports: {},
    },
  }
}

function sseResponse(lines: Array<string>): Response {
  return new Response(lines.join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

async function createUserToken(
  plain: string,
  opts: { monthlyTokenLimit?: number; isAdmin?: boolean } = {},
) {
  return createAuthToken({
    name: plain,
    tokenHash: hashToken(plain),
    tokenPrefix: plain.slice(0, 8),
    monthlyTokenLimit: opts.monthlyTokenLimit ?? null,
    isAdmin: opts.isAdmin ?? false,
  })
}

async function adminCookie(): Promise<string> {
  const adminId = await createAuthToken({
    name: "admin-viewer",
    tokenHash: hashToken("cpk-admin-viewer"),
    tokenPrefix: "cpk-admi",
    isAdmin: true,
  })
  const sid = await createSession({
    authTokenId: adminId,
    isSuperAdmin: false,
    ttlMs: 60_000,
  })
  return `cpk_session=${sid}`
}

beforeEach(() => {
  makeTestDb()
  resetResponsesRouting()
  state.authEnabled = true
  state.dashboardEnabled = true
  state.copilotToken = "test-copilot-token"
  state.accountType = "individual"
  state.copilotApiBaseUrl = undefined
  state.rateLimitSeconds = undefined
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      makeModel("gemini-2.5-pro", "Google", ["/chat/completions"]),
      makeModel("claude-native", "Anthropic", ["/v1/messages"]),
      makeModel("claude-translated", "Anthropic", ["/chat/completions"]),
      makeModel("gpt-5-codex", "OpenAI", ["/responses"]),
    ],
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  Object.assign(state, originalState)
  resetResponsesRouting()
})

describe("Streaming usage collection & client include_usage transparency", () => {
  test("Chat stream forces upstream include_usage=true, strips usage chunk when client omitted it, and records Gemini cache + reasoning", async () => {
    const tokenPlain = "cpk-gemini-stream-user"
    const tokenId = await createUserToken(tokenPlain)

    let upstreamBody: Record<string, unknown> | undefined
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      upstreamBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gemini-2.5-pro",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Hi" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gemini-2.5-pro",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gemini-2.5-pro",
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 250,
              total_tokens: 1250,
              prompt_tokens_details: { cached_tokens: 600 },
              completion_tokens_details: { reasoning_tokens: 150 },
            },
          })}\n\n`,
          `data: [DONE]\n\n`,
        ]),
      )
    }) as unknown as typeof fetch

    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPlain}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    expect(res.status).toBe(200)
    const clientSse = await res.text()

    // Upstream received stream_options.include_usage = true
    expect(upstreamBody?.stream_options).toEqual({ include_usage: true })
    // Client omitted include_usage, so usage-only chunk was NOT leaked to client
    expect(clientSse).not.toContain('"prompt_tokens":1000')
    expect(clientSse).toContain("data: [DONE]")

    const logs = await recentLogs({ tokenId, limit: 5 })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      promptTokens: 1000,
      cachedTokens: 600,
      cacheCreationTokens: null,
      completionTokens: 250,
      reasoningTokens: 150,
      totalTokens: 1250,
      billableTokens: 1250,
      usageComplete: 1,
      statusCode: 200,
    })

    const tok = await getAuthTokenById(tokenId)
    expect(tok?.monthlyTokenUsed).toBe(1250)
    expect(tok?.lifetimeTokenUsed).toBe(1250)
  })

  test("Chat stream forwards usage chunk when client explicitly sets include_usage=true", async () => {
    const tokenPlain = "cpk-include-usage-client"
    await createUserToken(tokenPlain)

    globalThis.fetch = (() =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            id: "chatcmpl-2",
            object: "chat.completion.chunk",
            created: 1,
            model: "gemini-2.5-pro",
            choices: [
              { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-2",
            object: "chat.completion.chunk",
            created: 1,
            model: "gemini-2.5-pro",
            choices: [],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 10,
              total_tokens: 60,
            },
          })}\n\n`,
          `data: [DONE]\n\n`,
        ]),
      )) as unknown as typeof fetch

    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPlain}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const clientSse = await res.text()
    expect(clientSse).toContain('"total_tokens":60')
  })
})

describe("Claude native vs translated cache parity", () => {
  test("Native /v1/messages and Chat-translated /v1/messages record identical total input and cache breakdown", async () => {
    const tokenPlain = "cpk-claude-parity"
    const tokenId = await createUserToken(tokenPlain)

    globalThis.fetch = ((url: unknown) => {
      const u = String(url)
      if (u.endsWith("/v1/messages")) {
        return Promise.resolve(
          sseResponse([
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-native",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 200,
                  cache_read_input_tokens: 800,
                  cache_creation_input_tokens: 150,
                  output_tokens: 0,
                },
              },
            })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 90 },
            })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ]),
        )
      }
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            id: "chatcmpl-cl",
            object: "chat.completion.chunk",
            created: 1,
            model: "claude-translated",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "done" },
                finish_reason: "stop",
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-cl",
            object: "chat.completion.chunk",
            created: 1,
            model: "claude-translated",
            choices: [],
            usage: {
              prompt_tokens: 1150,
              completion_tokens: 90,
              total_tokens: 1240,
              prompt_tokens_details: {
                cached_tokens: 800,
                cache_creation_input_tokens: 150,
              },
            },
          })}\n\n`,
          `data: [DONE]\n\n`,
        ]),
      )
    }) as unknown as typeof fetch

    for (const model of ["claude-native", "claude-translated"]) {
      const r = await server.request("/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": tokenPlain,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 256,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
      expect(r.status).toBe(200)
      await r.text()
    }

    const logs = await recentLogs({ tokenId, limit: 5 })
    expect(logs).toHaveLength(2)
    for (const log of logs) {
      expect(log).toMatchObject({
        promptTokens: 1150,
        cachedTokens: 800,
        cacheCreationTokens: 150,
        completionTokens: 90,
        totalTokens: 1240,
        billableTokens: 1240,
        usageComplete: 1,
      })
    }
    const tok = await getAuthTokenById(tokenId)
    expect(tok?.monthlyTokenUsed).toBe(2480)
  })
})

describe("Edge cases: zero output, interrupted streams, duplicate terminal events", () => {
  test("True zero completion_tokens is stored as 0, not null", async () => {
    const tokenPlain = "cpk-zero-output"
    const tokenId = await createUserToken(tokenPlain)

    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          id: "chatcmpl-zero",
          object: "chat.completion",
          created: 1,
          model: "gemini-2.5-pro",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 0,
            total_tokens: 42,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      )) as unknown as typeof fetch

    const res = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPlain}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "empty" }],
      }),
    })
    expect(res.status).toBe(200)
    const [log] = await recentLogs({ tokenId, limit: 1 })
    expect(log.completionTokens).toBe(0)
    expect(log.cachedTokens).toBe(0)
    expect(log.usageComplete).toBe(1)
  })

  test("Interrupted stream without final usage marks usageComplete=0 and keeps missing fields null", async () => {
    const tokenPlain = "cpk-interrupted"
    const tokenId = await createUserToken(tokenPlain)

    globalThis.fetch = (() =>
      Promise.resolve(
        sseResponse([
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_cut",
              type: "message",
              role: "assistant",
              model: "claude-native",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 120, output_tokens: 0 },
            },
          })}\n\n`,
          // Stream cuts off before message_delta / message_stop!
        ]),
      )) as unknown as typeof fetch

    const res = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": tokenPlain,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-native",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "cut" }],
      }),
    })
    await res.text()

    const [log] = await recentLogs({ tokenId, limit: 1 })
    expect(log.statusCode).toBe(502)
    expect(log.usageComplete).toBe(0)
    expect(log.promptTokens).toBe(120)
    expect(log.completionTokens).toBeNull()
    expect(log.totalTokens).toBeNull()
    expect(log.billableTokens).toBeNull()

    const tok = await getAuthTokenById(tokenId)
    expect(tok?.monthlyTokenUsed).toBe(0)
  })

  test("Duplicate terminal SSE events bill the request exactly once", async () => {
    const tokenPlain = "cpk-dup-terminal"
    const tokenId = await createUserToken(tokenPlain)

    globalThis.fetch = (() =>
      Promise.resolve(
        sseResponse([
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              object: "response",
              model: "gpt-5-codex",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
              },
            },
          })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              object: "response",
              model: "gpt-5-codex",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
              },
            },
          })}\n\n`,
        ]),
      )) as unknown as typeof fetch

    const res = await server.request("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPlain}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-codex",
        stream: true,
        input: "hello",
      }),
    })
    await res.text()

    const logs = await recentLogs({ tokenId, limit: 5 })
    expect(logs).toHaveLength(1)
    const tok = await getAuthTokenById(tokenId)
    expect(tok?.monthlyTokenUsed).toBe(150)
    expect(tok?.lifetimeTokenUsed).toBe(150)
  })
})

describe("Range parity, Monthly %, cache hit rate completeness, and log pruning immunity", () => {
  test("Chart timeseries matches per-token [from, to) total, Monthly % uses current month, and pruneOldLogs preserves monthly quota", async () => {
    const tokenPlain = "cpk-quota-persist"
    const tokenId = await createUserToken(tokenPlain, {
      monthlyTokenLimit: 500,
    })
    const cookie = await adminCookie()

    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          id: "chatcmpl-q",
          object: "chat.completion",
          created: 1,
          model: "gemini-2.5-pro",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 50,
            total_tokens: 250,
            prompt_tokens_details: { cached_tokens: 100 },
          },
        }),
      )) as unknown as typeof fetch

    // 2 live requests = 500 billable tokens -> hits monthly limit of 500
    for (let i = 0; i < 2; i++) {
      const r = await server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPlain}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-2.5-pro",
          messages: [{ role: "user", content: "q" }],
        }),
      })
      expect(r.status).toBe(200)
    }

    const now = Date.now()
    // Seed an out-of-window future log at now + 100_000 to verify `to` filtering
    await insertRequestLog({
      authTokenId: tokenId,
      timestamp: now + 100_000,
      endpoint: "/v1/chat/completions",
      statusCode: 200,
      promptTokens: 999,
      cachedTokens: 999,
      completionTokens: 1,
      totalTokens: 1000,
      billableTokens: 1000,
    })

    const from = now - 60_000
    const to = now + 5_000

    const [tsRes, ptRes, sumRes] = await Promise.all([
      server.request(
        `/admin/api/usage/timeseries?token_id=all&from=${from}&to=${to}&bucket=hour`,
        { headers: { cookie } },
      ),
      server.request(`/admin/api/usage/per-token?from=${from}&to=${to}`, {
        headers: { cookie },
      }),
      server.request(
        `/admin/api/usage/summary?token_id=all&from=${from}&to=${to}`,
        { headers: { cookie } },
      ),
    ])

    const tsRows = (await tsRes.json()) as Array<{ tokens: number }>
    const ptRows = (await ptRes.json()) as Array<{
      id: number
      tokens: number
      billable_tokens: number
      cache_hit_rate: number | null
      monthly_pct: number | null
    }>
    const sumBody = (await sumRes.json()) as {
      monthly_used: number
      range_breakdown: {
        billable_tokens: number
        cache_hit_rate: number | null
      }
    }

    const chartTotal = tsRows.reduce((s, r) => s + r.tokens, 0)
    const perTokenTotal = ptRows.reduce((s, r) => s + r.tokens, 0)
    expect(chartTotal).toBe(500)
    expect(perTokenTotal).toBe(500)
    expect(sumBody.range_breakdown.billable_tokens).toBe(500)
    // 200 cached out of 400 prompt tokens = 50%
    expect(sumBody.range_breakdown.cache_hit_rate).toBe(50)

    const userPt = ptRows.find((r) => r.id === tokenId)
    expect(userPt?.monthly_pct).toBe(100)
    expect(userPt?.cache_hit_rate).toBe(50)

    // Add a historical row WITHOUT cached_tokens in the same range -> cache_hit_rate becomes null ("未知")
    await insertRequestLog({
      authTokenId: tokenId,
      timestamp: now,
      endpoint: "/v1/chat/completions",
      statusCode: 200,
      promptTokens: 100,
      cachedTokens: null,
      completionTokens: 20,
      totalTokens: 120,
      billableTokens: 120,
    })
    const sumMixed = (await (
      await server.request(
        `/admin/api/usage/summary?token_id=${tokenId}&from=${from}&to=${to}`,
        { headers: { cookie } },
      )
    ).json()) as { range_breakdown: { cache_hit_rate: number | null } }
    expect(sumMixed.range_breakdown.cache_hit_rate).toBeNull()

    // Prune ALL request_logs — monthly quota MUST NOT recover!
    await pruneOldLogs(now + 500_000)

    const blocked = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPlain}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "blocked?" }],
      }),
    })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({
      error: { type: "monthly_quota_exceeded" },
    })

    const sumAfterPrune = (await (
      await server.request(`/admin/api/usage/summary?token_id=${tokenId}`, {
        headers: { cookie },
      })
    ).json()) as { monthly_used: number }
    expect(sumAfterPrune.monthly_used).toBe(500)
  })
})
