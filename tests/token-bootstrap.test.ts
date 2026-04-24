import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS } from "../src/lib/paths"
import { state } from "../src/lib/state"
import {
  bootstrapCopilotToken,
  clearGithubToken,
  deleteGithubTokenFile,
  stopCopilotTokenRefresh,
} from "../src/lib/token"

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_GH_PATH = PATHS.GITHUB_TOKEN_PATH
let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-token-"))
  ;(PATHS as { GITHUB_TOKEN_PATH: string }).GITHUB_TOKEN_PATH = path.join(
    tmpDir,
    "github-token",
  )
  state.githubToken = "g"
  state.githubLogin = "octocat"
  state.copilotToken = undefined
  state.models = { data: [], object: "list" } as never
})

afterEach(async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ORIGINAL_FETCH
  ;(PATHS as { GITHUB_TOKEN_PATH: string }).GITHUB_TOKEN_PATH = ORIGINAL_GH_PATH
  stopCopilotTokenRefresh()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("token bootstrap helpers", () => {
  test("bootstrapCopilotToken dedupes concurrent callers", async () => {
    let calls = 0
    const fetchMock = (() => {
      calls++
      return Promise.resolve(
        new Response(
          JSON.stringify({ token: "COP", expires_at: 0, refresh_in: 36_000 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

    const [a, b] = await Promise.all([
      bootstrapCopilotToken(),
      bootstrapCopilotToken(),
    ])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(calls).toBe(1)
    expect(state.copilotToken).toBe("COP")
    stopCopilotTokenRefresh()
  })

  test("clearGithubToken clears all state fields and unlinks file", async () => {
    await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, "g")
    await clearGithubToken()
    expect(state.githubToken).toBeUndefined()
    expect(state.githubLogin).toBeUndefined()
    expect(state.copilotToken).toBeUndefined()
    expect(state.models).toBeUndefined()
    const access = fs.access(PATHS.GITHUB_TOKEN_PATH)
    await expect(access).rejects.toBeDefined()
  })

  test("deleteGithubTokenFile resolves when file missing", async () => {
    const result = deleteGithubTokenFile()
    await expect(result).resolves.toBeUndefined()
  })
})
