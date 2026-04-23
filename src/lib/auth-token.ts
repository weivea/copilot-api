import consola from "consola"
import fs from "node:fs/promises"

import { hashToken, prefixOf } from "~/lib/auth-token-utils"
import { generateToken } from "~/lib/auth-token-utils"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

export { generateToken as generateAuthToken } from "~/lib/auth-token-utils"

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
  let generated = false
  if (!token) {
    token = generateToken()
    await saveAuthToken(token)
    generated = true
  }

  state.superAdminToken = token
  state.superAdminTokenHash = hashToken(token)

  if (generated || state.showToken) {
    consola.info(`Super admin token: ${token}`)
  }
  consola.info(`Auth: enabled (super admin prefix: ${prefixOf(token)})`)
}
