import { describe, expect, test } from "bun:test"

import type { State } from "../src/lib/state"

import {
  copilotBaseUrl,
  copilotHeaders,
  githubHeaders,
} from "../src/lib/api-config"

const makeState = (overrides?: Partial<State>): State => ({
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  authEnabled: false,
  dashboardEnabled: false,
  logRetentionDays: 90,
  copilotToken: "copilot-token",
  githubToken: "github-token",
  vsCodeVersion: "1.129.1",
  ...overrides,
})

describe("Copilot API configuration", () => {
  test("prefers and normalizes the API endpoint from the token envelope", () => {
    const state = makeState({
      accountType: "business",
      copilotApiBaseUrl: "https://custom.example.test/copilot/",
    })
    expect(copilotBaseUrl(state)).toBe("https://custom.example.test/copilot")
  })

  test("falls back to the configured account type", () => {
    expect(copilotBaseUrl(makeState())).toBe("https://api.githubcopilot.com")
    expect(copilotBaseUrl(makeState({ accountType: "enterprise" }))).toBe(
      "https://api.enterprise.githubcopilot.com",
    )
  })

  test("uses stable client and current Copilot interaction headers", () => {
    const headers = copilotHeaders(makeState())
    const nextHeaders = copilotHeaders(makeState())
    expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.59.0")
    expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.59.0")
    expect(headers["x-github-api-version"]).toBe("2026-06-01")
    expect(headers["x-interaction-type"]).toBe("conversation-panel")
    expect(headers["x-interaction-id"]).toBeUndefined()
    expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
    expect(headers["x-vscode-user-agent-library-version"]).toBe("node-http")
    expect(headers["VScode-SessionId"]).toBe(nextHeaders["VScode-SessionId"])
    expect(headers["VScode-MachineId"]).toBe(nextHeaders["VScode-MachineId"])
    expect(headers["Editor-Device-Id"]).toBe(nextHeaders["Editor-Device-Id"])
    expect(headers["x-request-id"]).not.toBe(nextHeaders["x-request-id"])
  })

  test("uses the GitHub API version for token and usage requests", () => {
    const headers = githubHeaders(makeState())
    expect(headers["x-github-api-version"]).toBe("2025-04-01")
  })
})
