import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  createAuthToken,
  getAuthTokenById,
  setLifetimeUsed,
} from "../src/db/queries/auth-tokens"
import {
  aggregateUsageSince,
  insertRequestLog,
  recentLogs,
  sumTokensSince,
} from "../src/db/queries/request-logs"
import { hashToken } from "../src/lib/auth-token-utils"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import { createImages } from "../src/services/copilot/create-images"
import { makeTestDb } from "./helpers/test-db"

const realFetch = globalThis.fetch
const originalState = { ...state }
const payload = { model: "test-image", prompt: "  A small blue square.  " }
const result = {
  created: 123,
  data: [{ b64_json: "aW1hZ2U=", revised_prompt: "A blue square." }],
  usage: {
    input_tokens: 4,
    output_tokens: 6,
    total_tokens: 10,
    input_tokens_details: { text_tokens: 4, image_tokens: 0 },
  },
  copilot_usage: { total_nano_aiu: 123 },
  extension: { retained: true },
}

beforeEach(() => {
  state.copilotToken = "upstream-token"
  state.copilotApiBaseUrl = "https://copilot.example.test/"
  state.authEnabled = false
})

afterEach(() => {
  globalThis.fetch = realFetch
  Object.assign(state, originalState)
})

function mockFetch(
  respond: (
    input: string | Request | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
) {
  globalThis.fetch = Object.assign(
    (input: string | Request | URL, init?: RequestInit) =>
      Promise.resolve(respond(input, init)),
    { preconnect: realFetch.preconnect },
  )
}

function request(path: string, body: unknown, token?: string) {
  return server.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
}

function editForm() {
  const form = new FormData()
  form.set("model", payload.model)
  form.set("prompt", payload.prompt)
  form.append(
    "image[]",
    new Blob(["first"], { type: "image/png" }),
    "first.png",
  )
  form.append(
    "image[]",
    new Blob(["second"], { type: "image/webp" }),
    "second.webp",
  )
  form.set("mask", new Blob(["mask"], { type: "image/png" }), "mask.png")
  form.set("stream", "false")
  form.append("extension", "one")
  form.append("extension", "two")
  return form
}

function sse(body: string) {
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

describe("Images API", () => {
  test.each(["/v1/images/generations", "/images/generations"])(
    "%s forwards JSON, parameters and upstream image results unchanged",
    async (endpoint) => {
      const body = {
        ...payload,
        quality: "max",
        output_format: "webp",
        size: "1536x864",
        n: 2,
        extension: { retained: true },
      }
      mockFetch((url, init) => {
        expect(url).toBe("https://copilot.example.test/v1/images/generations")
        if (typeof init?.body !== "string") throw new Error("Missing JSON body")
        expect(JSON.parse(init.body)).toEqual(body)
        const headers = new Headers(init.headers)
        expect(headers.get("authorization")).toBe("Bearer upstream-token")
        expect(headers.get("copilot-integration-id")).toBe("vscode-chat")
        expect(headers.get("x-initiator")).toBe("user")
        expect(headers.get("content-type")).toBe("application/json")
        return Response.json(result, {
          headers: { "x-request-id": "image-1", "x-ratelimit-remaining": "9" },
        })
      })
      const response = await request(endpoint, body)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(result)
      expect(response.headers.get("x-request-id")).toBe("image-1")
      expect(response.headers.get("x-ratelimit-remaining")).toBe("9")
    },
  )

  test.each(["/v1/images/edits", "/images/edits"])(
    "%s preserves multipart images, mask, filenames and repeated fields",
    async (endpoint) => {
      mockFetch(async (url, init) => {
        expect(url).toBe("https://copilot.example.test/v1/images/edits")
        expect(new Headers(init?.headers).get("content-type")).toBeNull()
        expect(new Headers(init?.headers).get("copilot-vision-request")).toBe(
          "true",
        )
        if (!(init?.body instanceof FormData))
          throw new Error("Missing multipart body")
        const form = init.body
        const files = form.getAll("image[]")
        expect(files).toHaveLength(2)
        expect(files[0]).toBeInstanceOf(File)
        if (!(files[0] instanceof File) || !(files[1] instanceof File))
          throw new Error("Missing image files")
        expect(files[0].name).toBe("first.png")
        expect(files[0].type).toBe("image/png")
        expect(await files[0].text()).toBe("first")
        expect(files[1].name).toBe("second.webp")
        expect(await files[1].text()).toBe("second")
        const mask = form.get("mask")
        if (!(mask instanceof File)) throw new Error("Missing mask")
        expect(mask.name).toBe("mask.png")
        expect(await mask.text()).toBe("mask")
        expect(form.getAll("extension")).toEqual(["one", "two"])
        expect(form.get("stream")).toBe("false")
        expect(form.get("prompt")).toBe(payload.prompt)
        return Response.json(result)
      })
      const response = await server.request(endpoint, {
        method: "POST",
        body: editForm(),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(result)
    },
  )

  test("JSON edits retain URL and upstream file references without downloading them", async () => {
    const body = {
      ...payload,
      images: [
        { image_url: "data:image/png;base64,AA==", detail: "high" },
        { file_id: "upstream-file" },
      ],
      mask: { image_url: "https://example.test/mask.png" },
    }
    mockFetch((_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Missing JSON body")
      expect(JSON.parse(init.body)).toEqual(body)
      return Response.json(result)
    })
    const response = await request("/v1/images/edits", body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
  })

  test.each([
    { operation: "generations", body: { ...payload, model: "" } },
    { operation: "generations", body: { ...payload, prompt: " " } },
    { operation: "generations", body: { ...payload, stream: "false" } },
    { operation: "edits", body: payload },
    { operation: "edits", body: { ...payload, images: [] } },
    { operation: "edits", body: { ...payload, images: [{}] } },
    {
      operation: "edits",
      body: { ...payload, images: [{ image_url: "url", file_id: "file" }] },
    },
  ])("rejects malformed image payloads %j", async ({ operation, body }) => {
    mockFetch(() => {
      throw new Error("Must not call upstream")
    })
    const response = await request(`/v1/images/${operation}`, body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  })

  test.each(["image", "mask", "stream"])(
    "validates multipart %s",
    async (field) => {
      const form = editForm()
      if (field === "image") form.delete("image[]")
      else form.set(field, field === "stream" ? "yes" : "not-a-file")
      mockFetch(() => {
        throw new Error("Must not call upstream")
      })
      const response = await server.request("/v1/images/edits", {
        method: "POST",
        body: form,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      })
    },
  )

  test.each([
    { contentType: "application/json", body: "{" },
    { contentType: "multipart/form-data", body: "invalid" },
    { contentType: "text/plain", body: "invalid" },
  ])(
    "invalid request encoding yields 400: %j",
    async ({ contentType, body }) => {
      const response = await server.request("/v1/images/edits", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
      expect(response.status).toBe(400)
    },
  )

  test.each([403, 429])(
    "preserves upstream %s errors and retry headers",
    async (status) => {
      mockFetch(() =>
        Response.json(
          { error: { message: "Image access denied", code: "image_policy" } },
          {
            status,
            headers: { "retry-after": "5", "x-request-id": "image-error" },
          },
        ),
      )
      const response = await request("/v1/images/generations", payload)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({
        error: { message: "Image access denied", code: "image_policy" },
      })
      expect(response.headers.get("retry-after")).toBe("5")
      expect(response.headers.get("x-request-id")).toBe("image-error")
    },
  )

  test.each([
    "/v1/images/generations",
    "/images/generations",
    "/v1/images/edits",
    "/images/edits",
  ])(
    "%s enforces authentication, readiness, usage and quota",
    async (endpoint) => {
      makeTestDb()
      state.authEnabled = true
      const tokenId = await createAuthToken({
        name: "image-user",
        tokenHash: hashToken("proxy-token"),
        tokenPrefix: "proxy",
        lifetimeTokenLimit: 10,
      })
      const body =
        endpoint.endsWith("/edits") ?
          {
            ...payload,
            images: [{ image_url: "https://example.test/input.png" }],
          }
        : payload
      expect((await request(endpoint, body)).status).toBe(401)
      state.copilotToken = undefined
      expect((await request(endpoint, body, "proxy-token")).status).toBe(503)
      state.copilotToken = "upstream-token"
      mockFetch((_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer upstream-token",
        )
        return Response.json(result)
      })
      expect((await request(endpoint, body, "proxy-token")).status).toBe(200)
      expect((await recentLogs({ tokenId, limit: 1 }))[0]).toMatchObject({
        endpoint,
        model: payload.model,
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
        costNanoAiu: 123,
      })
      expect((await getAuthTokenById(tokenId))?.lifetimeTokenUsed).toBe(10)
      expect((await request(endpoint, body, "proxy-token")).status).toBe(403)
    },
  )

  test.each(["monthly", "lifetime"])(
    "combines chat, Decisions and image tokens for the %s limit",
    async (limit) => {
      makeTestDb()
      state.authEnabled = true
      const tokenId = await createAuthToken({
        name: "shared-quota-user",
        tokenHash: hashToken("shared-token"),
        tokenPrefix: "shared",
        monthlyTokenLimit: limit === "monthly" ? 25 : null,
        lifetimeTokenLimit: limit === "lifetime" ? 25 : null,
      })
      await insertRequestLog({
        authTokenId: tokenId,
        timestamp: Date.now(),
        endpoint: "/v1/chat/completions",
        totalTokens: 5,
        statusCode: 200,
      })
      await setLifetimeUsed(tokenId, 5)
      const decision = {
        model: "test-decisions",
        input: "The service is down.",
        questions: [
          {
            type: "predicate",
            name: "outage",
            instructions: "Is there an outage?",
          },
        ],
      }
      let upstreamCalls = 0
      mockFetch((url) => {
        if (typeof url !== "string") throw new Error("Expected upstream URL")
        upstreamCalls++
        return Response.json(
          url.endsWith("/decisions") ?
            {
              answers: [{ type: "predicate", name: "outage", probability: 1 }],
              usage: { input_tokens: 10, output_tokens: 0 },
            }
          : {
              ...result,
              usage: {
                input_tokens: 4,
                output_tokens: 6,
                input_tokens_details: { text_tokens: 1, image_tokens: 3 },
              },
            },
        )
      })
      const decisionResponse = await request(
        "/v1/decisions",
        decision,
        "shared-token",
      )
      expect(decisionResponse.status).toBe(200)
      expect(await decisionResponse.json()).toMatchObject({
        usage: { input_tokens: 10, output_tokens: 0 },
      })
      expect(
        (await request("/v1/images/generations", payload, "shared-token"))
          .status,
      ).toBe(200)
      expect(await sumTokensSince(tokenId, 0)).toBe(25)
      expect(await aggregateUsageSince(0)).toEqual({ requests: 3, tokens: 25 })
      expect((await getAuthTokenById(tokenId))?.lifetimeTokenUsed).toBe(25)
      const logs = await recentLogs({ tokenId, limit: 3 })
      expect(
        logs.find((log) => log.endpoint === "/v1/decisions"),
      ).toMatchObject({
        promptTokens: 10,
        completionTokens: 0,
        totalTokens: 10,
      })
      expect(
        logs.find((log) => log.endpoint === "/v1/images/generations"),
      ).toMatchObject({
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
      })
      for (const endpoint of [
        "/decisions",
        "/v1/decisions",
        "/images/generations",
        "/v1/images/generations",
        "/images/edits",
        "/v1/images/edits",
      ]) {
        const response = await request(endpoint, decision, "shared-token")
        expect(response.status).toBe(limit === "monthly" ? 429 : 403)
        expect(await response.json()).toMatchObject({
          error: {
            type:
              limit === "monthly" ?
                "monthly_quota_exceeded"
              : "account_quota_exhausted",
          },
        })
      }
      expect(upstreamCalls).toBe(2)
    },
  )

  test.each(
    ["generations", "edits"].flatMap((operation) =>
      ["monthly", "lifetime"].map((limit) => ({ operation, limit })),
    ),
  )(
    "streaming images record final usage once and enforce the shared quota %j",
    async ({ operation, limit }) => {
      makeTestDb()
      state.authEnabled = true
      const tokenId = await createAuthToken({
        name: "stream-user",
        tokenHash: hashToken("stream-token"),
        tokenPrefix: "stream",
        monthlyTokenLimit: limit === "monthly" ? 10 : null,
        lifetimeTokenLimit: limit === "lifetime" ? 10 : null,
      })
      const prefix = operation === "edits" ? "image_edit" : "image_generation"
      const partial = {
        type: `${prefix}.partial_image`,
        b64_json: "cGFydGlhbA==",
        partial_image_index: 0,
        usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4 },
      }
      const completed = {
        type: `${prefix}.completed`,
        b64_json: "ZmluYWw=",
        ...result,
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          input_tokens_details: { text_tokens: 1, image_tokens: 3 },
        },
      }
      mockFetch(() =>
        sse(
          `event: ${partial.type}\ndata: ${JSON.stringify(partial)}\n\n`
            + `event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`,
        ),
      )
      const form = editForm()
      form.set("stream", "true")
      const response =
        operation === "edits" ?
          await server.request("/v1/images/edits", {
            method: "POST",
            body: form,
            headers: { authorization: "Bearer stream-token" },
          })
        : await request(
            "/v1/images/generations",
            { ...payload, stream: true, partial_images: 1 },
            "stream-token",
          )
      const body = await response.text()
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      )
      expect(body).toContain(`data: ${JSON.stringify(partial)}`)
      expect(body).toContain(`data: ${JSON.stringify(completed)}`)
      expect(body).not.toContain("event: error")
      expect((await recentLogs({ tokenId, limit: 1 }))[0]).toMatchObject({
        totalTokens: 10,
        costNanoAiu: 123,
        statusCode: 200,
      })
      expect((await getAuthTokenById(tokenId))?.lifetimeTokenUsed).toBe(10)
      expect(await sumTokensSince(tokenId, 0)).toBe(10)
      expect(await aggregateUsageSince(0)).toEqual({ requests: 1, tokens: 10 })
      const blocked = await request(
        "/v1/images/generations",
        payload,
        "stream-token",
      )
      expect(blocked.status).toBe(limit === "monthly" ? 429 : 403)
      expect(await blocked.json()).toMatchObject({
        error: {
          type:
            limit === "monthly" ?
              "monthly_quota_exceeded"
            : "account_quota_exhausted",
        },
      })
    },
  )

  test.each(["", "data: [DONE]\n\n", "data: invalid\n\n"])(
    "reports incomplete or malformed image streams rather than successful completion: %j",
    async (body) => {
      mockFetch(() => sse(body))
      const response = await request("/v1/images/generations", {
        ...payload,
        stream: true,
      })
      expect(await response.text()).toContain('"code":"upstream_error"')
    },
  )

  test("upstream stream errors are forwarded and logged as failures", async () => {
    makeTestDb()
    state.authEnabled = true
    const tokenId = await createAuthToken({
      name: "error-user",
      tokenHash: hashToken("error-token"),
      tokenPrefix: "error",
    })
    const event =
      'event: error\ndata: {"type":"error","code":"image_policy","message":"Blocked"}\n\n'
    mockFetch(() => sse(event))
    const response = await request(
      "/v1/images/generations",
      { ...payload, stream: true },
      "error-token",
    )
    expect(await response.text()).toBe(event)
    expect((await recentLogs({ tokenId, limit: 1 }))[0]?.statusCode).toBe(502)
  })

  test.each(["not-json", "null"])(
    "invalid upstream JSON is a 502: %s",
    async (body) => {
      mockFetch(() => new Response(body))
      const response = await request("/v1/images/generations", payload)
      expect(response.status).toBe(502)
    },
  )

  test("a non-SSE response to a streaming request is a 502", async () => {
    mockFetch(() => Response.json(result))
    const response = await request("/v1/images/generations", {
      ...payload,
      stream: true,
    })
    expect(response.status).toBe(502)
  })

  test("passes cancellation to the upstream image request", () => {
    const controller = new AbortController()
    controller.abort()
    mockFetch((_url, init) => {
      expect(init?.signal).toBe(controller.signal)
      return Promise.reject(new Error("Aborted"))
    })
    expect(
      createImages("generations", payload, controller.signal),
    ).rejects.toThrow("Aborted")
  })

  test("cancelling the image event stream aborts the upstream fetch", async () => {
    let aborted = false
    mockFetch((_url, init) => {
      const signal = init?.signal
      if (!signal) throw new Error("Missing upstream cancellation signal")
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"cGFydGlhbA=="}\n\n',
            ),
          )
          signal.addEventListener(
            "abort",
            () => {
              aborted = true
              controller.error(new Error("Aborted"))
            },
            { once: true },
          )
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    })
    const response = await request("/v1/images/generations", {
      ...payload,
      stream: true,
    })
    if (!response.body) throw new Error("Missing image stream")
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    expect(aborted).toBe(true)
  })

  test.each(["/images/unknown", "/v1/images/variations"])(
    "unsupported image paths return JSON 404: %s",
    async (path) => {
      const response = await server.request(path)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        error: { code: "not_found" },
      })
    },
  )
})
