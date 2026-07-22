import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.59.0"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

// Source: @vscode/copilot-api@0.4.3, used by VS Code 1.129 stable.
const COPILOT_API_VERSION = "2026-06-01"
const GITHUB_API_VERSION = "2025-04-01"
const CLIENT_SESSION_ID = randomUUID()
const CLIENT_MACHINE_ID = randomUUID()
const CLIENT_DEVICE_ID = randomUUID()

export const copilotBaseUrl = (state: State) =>
  state.copilotApiBaseUrl?.replace(/\/+$/, "")
  ?? (state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`)
export const copilotHeaders = (state: State, vision: boolean = false) => {
  const requestId = randomUUID()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": COPILOT_API_VERSION,
    "x-request-id": requestId,
    "x-interaction-type": "conversation-panel",
    "x-agent-task-id": requestId,
    "VScode-SessionId": CLIENT_SESSION_ID,
    "VScode-MachineId": CLIENT_MACHINE_ID,
    "Editor-Device-Id": CLIENT_DEVICE_ID,
    "x-vscode-user-agent-library-version": "node-http",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": GITHUB_API_VERSION,
  "x-vscode-user-agent-library-version": "node-http",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
