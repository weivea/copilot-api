import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

export const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export async function deleteGithubTokenFile(): Promise<void> {
  try {
    await fs.unlink(PATHS.GITHUB_TOKEN_PATH)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
let bootstrapping = false

export function stopCopilotTokenRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

export async function bootstrapCopilotToken(): Promise<void> {
  if (bootstrapping) return
  bootstrapping = true
  try {
    stopCopilotTokenRefresh()
    const { token, refresh_in } = await getCopilotToken()
    state.copilotToken = token
    consola.debug("GitHub Copilot Token fetched successfully!")
    if (state.showToken) consola.info("Copilot token:", token)

    const refreshInterval = (refresh_in - 60) * 1000
    refreshTimer = setInterval(async () => {
      consola.debug("Refreshing Copilot token")
      try {
        const { token } = await getCopilotToken()
        state.copilotToken = token
        consola.debug("Copilot token refreshed")
        if (state.showToken) consola.info("Refreshed Copilot token:", token)
      } catch (error) {
        consola.error("Failed to refresh Copilot token:", error)
      }
    }, refreshInterval)
  } finally {
    // eslint-disable-next-line require-atomic-updates
    bootstrapping = false
  }
}

// Backwards-compatible alias used by `auth` and `check-usage` CLI commands.
export const setupCopilotToken = bootstrapCopilotToken

interface SetupGitHubTokenOptions {
  force?: boolean
  optional?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken().catch(() => "")
    const trimmed = githubToken.trim()

    if (trimmed && !options?.force) {
      state.githubToken = trimmed
      if (state.showToken) consola.info("GitHub token:", trimmed)
      await logUser()
      return
    }

    if (options?.optional) {
      consola.warn("GitHub token missing — sign in via dashboard")
      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) consola.info("GitHub token:", token)
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }
    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function clearGithubToken(): Promise<void> {
  stopCopilotTokenRefresh()
  await deleteGithubTokenFile()
  state.githubToken = undefined
  state.githubLogin = undefined
  state.copilotToken = undefined
  state.models = undefined
}

async function logUser() {
  const user = await getGitHubUser()
  state.githubLogin = user.login
  consola.info(`Logged in as ${user.login}`)
}
