import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS } from "../src/lib/paths"
import { state } from "../src/lib/state"
import { stopCopilotTokenRefresh } from "../src/lib/token"
import {
  __resetDeviceFlowsForTest,
  startDeviceFlow,
  getFlow,
  cancelFlow,
} from "../src/services/github/device-flow-manager"

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_GH_PATH = PATHS.GITHUB_TOKEN_PATH
let tmpDir: string

type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Response | Promise<Response>

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function installFetchQueue(handlers: Array<FetchHandler>): { calls: number } {
  const counter = { calls: 0 }
  const fetchMock = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const handler = handlers.shift()
    counter.calls++
    if (!handler) {
      throw new Error(`Unexpected fetch call to ${urlOf(input)}`)
    }
    return Promise.resolve(handler(input, init))
  }) as unknown as typeof fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
  return counter
}

async function waitForStatus(
  id: string,
  predicate: (status: string | undefined) => boolean,
  timeoutMs = 2000,
): Promise<string | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = getFlow(id)?.status
    if (predicate(status)) return status
    await new Promise((r) => setTimeout(r, 20))
  }
  return getFlow(id)?.status
}

const deviceCodeBody = {
  device_code: "DCODE",
  user_code: "USER-CODE",
  verification_uri: "https://github.com/login/device",
  verification_uri_complete: "https://github.com/login/device?user_code=USER",
  expires_in: 900,
  interval: 0,
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-devflow-"))
  ;(PATHS as { GITHUB_TOKEN_PATH: string }).GITHUB_TOKEN_PATH = path.join(
    tmpDir,
    "github-token",
  )
  state.githubToken = undefined
  state.githubLogin = undefined
  state.copilotToken = undefined
  state.models = undefined
  __resetDeviceFlowsForTest()
})

afterEach(async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ORIGINAL_FETCH
  ;(PATHS as { GITHUB_TOKEN_PATH: string }).GITHUB_TOKEN_PATH = ORIGINAL_GH_PATH
  stopCopilotTokenRefresh()
  __resetDeviceFlowsForTest()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("device flow manager", () => {
  test("happy path completes and populates state", async () => {
    installFetchQueue([
      () => jsonResponse(deviceCodeBody),
      () => jsonResponse({ error: "authorization_pending" }),
      () => jsonResponse({ access_token: "GH_TOKEN", token_type: "bearer" }),
      () => jsonResponse({ login: "octocat" }),
      () =>
        jsonResponse({ token: "COP_TOKEN", expires_at: 0, refresh_in: 1800 }),
      (input) => {
        if (!urlOf(input).includes("/models")) {
          throw new Error(`Expected models call, got ${urlOf(input)}`)
        }
        return jsonResponse({ data: [] })
      },
    ])

    const flow = await startDeviceFlow("super")
    const status = await waitForStatus(
      flow.id,
      (s) => s === "success" || s === "error" || s === "expired",
    )
    expect(status).toBe("success")
    expect(state.githubToken).toBe("GH_TOKEN")
    expect(state.githubLogin).toBe("octocat")
    expect(getFlow(flow.id)?.login).toBe("octocat")
    const written = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    expect(written).toBe("GH_TOKEN")
  })

  test("access_denied marks flow as error", async () => {
    installFetchQueue([
      () => jsonResponse(deviceCodeBody),
      () => jsonResponse({ error: "access_denied" }),
    ])
    const flow = await startDeviceFlow(1)
    const status = await waitForStatus(flow.id, (s) => s === "error")
    expect(status).toBe("error")
    expect(getFlow(flow.id)?.error).toBe("User denied access")
  })

  test("expired_token marks flow as expired", async () => {
    installFetchQueue([
      () => jsonResponse(deviceCodeBody),
      () => jsonResponse({ error: "expired_token" }),
    ])
    const flow = await startDeviceFlow(1)
    const status = await waitForStatus(flow.id, (s) => s === "expired")
    expect(status).toBe("expired")
  })

  test("cancelFlow marks pending flow as cancelled", async () => {
    installFetchQueue([
      () => jsonResponse(deviceCodeBody),
      () => jsonResponse({ error: "authorization_pending" }),
      () => jsonResponse({ error: "authorization_pending" }),
      () => jsonResponse({ error: "authorization_pending" }),
    ])
    const flow = await startDeviceFlow(1)
    cancelFlow(flow.id)
    const status = await waitForStatus(flow.id, (s) => s === "cancelled")
    expect(status).toBe("cancelled")
  })

  test("repeat start while pending returns same flow", async () => {
    installFetchQueue([
      () => jsonResponse(deviceCodeBody),
      () => jsonResponse({ error: "authorization_pending" }),
      () => jsonResponse({ error: "authorization_pending" }),
      () => jsonResponse({ error: "authorization_pending" }),
    ])
    const a = await startDeviceFlow(1)
    const b = await startDeviceFlow(1)
    expect(b.id).toBe(a.id)
  })
})
