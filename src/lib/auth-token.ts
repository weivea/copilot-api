import consola from "consola"
import crypto from "node:crypto"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

export function generateAuthToken(): string {
  const bytes = crypto.randomBytes(32)
  return `cpk-${bytes.toString("hex")}`
}

export async function loadAuthToken(): Promise<string | undefined> {
  try {
    const token = await fs.readFile(PATHS.AUTH_TOKEN_PATH, "utf8")
    const trimmed = token.trim()
    return trimmed || undefined
  } catch {
    return undefined
  }
}

export async function saveAuthToken(token: string): Promise<void> {
  await fs.writeFile(PATHS.AUTH_TOKEN_PATH, token)
  await fs.chmod(PATHS.AUTH_TOKEN_PATH, 0o600)
}

export async function setupAuthToken(): Promise<void> {
  if (!state.authEnabled) {
    consola.info("Auth: disabled")
    return
  }

  let token = await loadAuthToken()

  if (!token) {
    token = generateAuthToken()
    await saveAuthToken(token)
    consola.info(`Auth token generated: ${token}`)
  }

  // eslint-disable-next-line require-atomic-updates
  state.authToken = token
  consola.info(`Auth: enabled (token: ${token})`)
}
