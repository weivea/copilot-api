import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  createAuthToken,
  getAuthTokenById,
} from "../src/db/queries/auth-tokens"
import { recentLogs } from "../src/db/queries/request-logs"
import { hashToken } from "../src/lib/auth-token-utils"
import { state } from "../src/lib/state"
import { decisionsRoutes } from "../src/routes/decisions/route"
import { server } from "../src/server"
import { createDecisions } from "../src/services/copilot/create-decisions"
import { makeTestDb } from "./helpers/test-db"

const realFetch = globalThis.fetch
const originalState = { ...state }
const question = {
  type: "predicate" as const,
  name: "outage",
  instructions: "  Does the input describe an outage?  ",
}
const payload = {
  model: "test-decisions",
  input: "The service is down.",
  questions: [question],
}

beforeEach(() => {
  state.copilotToken = "test-upstream-token"
  state.copilotApiBaseUrl = "https://api.githubcopilot.com"
  state.authEnabled = false
})

afterEach(() => {
  globalThis.fetch = realFetch
  Object.assign(state, originalState)
})

function request(body: unknown) {
  return decisionsRoutes.request("/", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("Decisions endpoint", () => {
  test.each(["/v1/decisions", "/decisions"])(
    "%s forwards typed questions and preserves upstream extensions",
    async (endpoint) => {
      state.copilotApiBaseUrl = "https://copilot.example.test/"
      const body = {
        ...payload,
        prompt_cache_key: "shared-input",
        questions: [
          question,
          {
            type: "choice",
            name: "department",
            instructions: "Choose a team.",
            choices: [
              { value: "engineering", description: "Bugs", extension: true },
              { value: false },
            ],
          },
          {
            type: "score",
            name: "severity",
            instructions: "Rate the severity.",
            levels: [{ label: "minor" }, { label: "critical" }],
          },
        ],
      }
      const upstream = {
        model: "test-decisions",
        answers: [
          { type: "predicate", name: "outage", probability: 0.99 },
          { type: "choice", name: "department", choice: "engineering" },
          { type: "score", name: "severity", score: 0.9 },
        ],
        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
        copilot_usage: { total_nano_aiu: 123 },
        extension: { retained: true },
      }
      let sent: unknown
      let url: unknown
      let headers = new Headers()
      globalThis.fetch = Object.assign(
        (input: string | Request | URL, init?: RequestInit) => {
          url = input
          headers = new Headers(init?.headers)
          if (typeof init?.body !== "string") throw new Error("Missing JSON")
          sent = JSON.parse(init.body) as unknown
          return Promise.resolve(
            Response.json(upstream, {
              headers: {
                "x-request-id": "req-1",
                "x-ratelimit-remaining": "9",
              },
            }),
          )
        },
        { preconnect: realFetch.preconnect },
      )
      const response = await server.request(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(upstream)
      expect(sent).toEqual(body)
      expect(url).toBe("https://copilot.example.test/v1/decisions")
      expect(headers.get("authorization")).toBe("Bearer test-upstream-token")
      expect(headers.get("copilot-integration-id")).toBe("vscode-chat")
      expect(response.headers.get("x-request-id")).toBe("req-1")
      expect(response.headers.get("x-ratelimit-remaining")).toBe("9")
    },
  )

  test.each(["input", "instructions"])(
    "preserves structured input and sets vision headers for images in %s",
    async (location) => {
      const image = {
        type: "input_image",
        image_url: "data:image/png;base64,AA==",
      }
      const body = {
        ...payload,
        input: [
          {
            role: "user",
            content: [
              { type: "input_json", data: { status: 500 } },
              ...(location === "input" ? [image] : []),
            ],
          },
        ],
        questions: [
          {
            ...question,
            instructions:
              location === "instructions" ?
                [{ type: "input_text", text: "Check this image." }, image]
              : question.instructions,
          },
        ],
      }
      globalThis.fetch = Object.assign(
        (_input: string | Request | URL, init?: RequestInit) => {
          expect(new Headers(init?.headers).get("copilot-vision-request")).toBe(
            "true",
          )
          if (typeof init?.body !== "string") throw new Error("Missing JSON")
          expect(JSON.parse(init.body)).toEqual(body)
          return Promise.resolve(
            Response.json({ answers: [{ type: "refusal", name: "outage" }] }),
          )
        },
        { preconnect: realFetch.preconnect },
      )
      const response = await request(body)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        answers: [{ type: "refusal", name: "outage" }],
      })
    },
  )

  test.each([
    { ...payload, model: "" },
    { ...payload, input: null },
    { ...payload, stream: true },
    { ...payload, questions: [] },
    { ...payload, questions: [question, question] },
    { ...payload, questions: [{ ...question, instructions: " " }] },
    { ...payload, questions: [{ ...question, type: "unknown" }] },
    {
      ...payload,
      questions: [{ ...question, type: "choice", choices: [{ value: "x" }] }],
    },
    {
      ...payload,
      questions: [
        {
          ...question,
          type: "choice",
          choices: [{ value: "x" }, { value: "x" }],
        },
      ],
    },
    {
      ...payload,
      questions: [{ ...question, type: "score", levels: [{ label: "low" }] }],
    },
    {
      ...payload,
      questions: Array.from({ length: 401 }, (_, i) => ({
        ...question,
        name: `q${i}`,
      })),
    },
  ])(
    "rejects malformed or unsupported payloads without calling upstream",
    async (body) => {
      let called = false
      globalThis.fetch = Object.assign(
        () => {
          called = true
          throw new Error("Unexpected upstream call")
        },
        { preconnect: realFetch.preconnect },
      )
      const response = await request(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      })
      expect(called).toBe(false)
    },
  )

  test("invalid JSON returns 400", async () => {
    const response = await decisionsRoutes.request("/", {
      method: "POST",
      body: "{",
    })
    expect(response.status).toBe(400)
  })

  test("accepts a batch at the 400-question limit", async () => {
    const questions = Array.from({ length: 400 }, (_, i) => ({
      ...question,
      name: `q${i}`,
    }))
    const answers = questions.map(({ name }) => ({
      type: "predicate",
      name,
      probability: 1,
    }))
    globalThis.fetch = Object.assign(
      () => Promise.resolve(Response.json({ answers })),
      { preconnect: realFetch.preconnect },
    )
    const response = await request({ ...payload, questions })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answers })
  })

  test.each([
    {
      status: 429,
      body: { error: { message: "Slow down", code: "rate_limit_exceeded" } },
    },
    {
      status: 400,
      body: "Personal Access Tokens are not supported for this endpoint",
    },
    {
      status: 403,
      body: {
        error: {
          message: "Decisions unavailable",
          code: "model_not_available",
        },
      },
    },
  ])(
    "preserves upstream errors and retry headers %j",
    async ({ status, body }) => {
      globalThis.fetch = Object.assign(
        () =>
          Promise.resolve(
            new Response(
              typeof body === "string" ? body : JSON.stringify(body),
              {
                status,
                headers: { "retry-after": "5", "x-request-id": "err-1" },
              },
            ),
          ),
        { preconnect: realFetch.preconnect },
      )
      const response = await request(payload)
      expect(response.status).toBe(status)
      expect(response.headers.get("retry-after")).toBe("5")
      expect(response.headers.get("x-request-id")).toBe("err-1")
      expect(await response.json()).toMatchObject({
        error: {
          message: typeof body === "string" ? body : body.error.message,
          code: typeof body === "string" ? null : body.error.code,
        },
      })
    },
  )

  test.each(["/v1/decisions", "/decisions"])(
    "%s enforces authentication, readiness, usage accounting and quota",
    async (endpoint) => {
      makeTestDb()
      state.authEnabled = true
      const tokenId = await createAuthToken({
        name: "decisions-user",
        tokenHash: hashToken("proxy-token"),
        tokenPrefix: "proxy",
        lifetimeTokenLimit: 10,
      })
      const init = {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { Authorization: "Bearer proxy-token" },
      }
      expect((await server.request(endpoint, { method: "POST" })).status).toBe(
        401,
      )
      state.copilotToken = undefined
      expect((await server.request(endpoint, init)).status).toBe(503)
      state.copilotToken = "test-upstream-token"
      globalThis.fetch = Object.assign(
        () =>
          Promise.resolve(
            Response.json({
              answers: [{ type: "predicate", name: "outage", probability: 1 }],
              usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
              copilot_usage: { total_nano_aiu: 123 },
            }),
          ),
        { preconnect: realFetch.preconnect },
      )
      expect((await server.request(endpoint, init)).status).toBe(200)
      const logs = await recentLogs({ tokenId, limit: 1 })
      expect(logs[0]).toMatchObject({
        endpoint,
        model: payload.model,
        promptTokens: 10,
        completionTokens: 0,
        totalTokens: 10,
        costNanoAiu: 123,
      })
      expect((await getAuthTokenById(tokenId))?.lifetimeTokenUsed).toBe(10)
      expect((await server.request(endpoint, init)).status).toBe(403)
    },
  )

  test("passes cancellation to the upstream request", () => {
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = Object.assign(
      (_input: string | Request | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal)
        return Promise.reject(new Error("Aborted"))
      },
      { preconnect: realFetch.preconnect },
    )
    expect(
      createDecisions(payload, { signal: controller.signal }),
    ).rejects.toThrow("Aborted")
  })

  test("unknown Decisions paths return JSON 404 instead of SPA HTML", async () => {
    const response = await server.request("/decisions/unknown")
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "not_found" },
    })
  })
})
