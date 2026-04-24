import consola from "consola"
import fs from "node:fs/promises"

import {
  createAuthToken,
  findAuthTokenByHash,
  updateAuthToken,
} from "~/db/queries/auth-tokens"
import { hashToken, prefixOf } from "~/lib/auth-token-utils"
import { generateToken } from "~/lib/auth-token-utils"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

export { generateToken as generateAuthToken } from "~/lib/auth-token-utils"

const SUPER_ADMIN_NAME = "__super_admin__"

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

  // Ensure a row exists in auth_tokens so request logs / usage stats
  // can attribute super admin requests to a stable id.
  try {
    const hash = state.superAdminTokenHash
    const existing = await findAuthTokenByHash(hash)
    if (existing) {
      state.superAdminTokenId = existing.id
      // Keep the row in sync if super-admin token was rotated.
      if (existing.name !== SUPER_ADMIN_NAME || existing.isAdmin !== 1) {
        await updateAuthToken(existing.id, {
          name: SUPER_ADMIN_NAME,
          isAdmin: true,
          isDisabled: false,
        })
      }
    } else {
      const id = await createAuthToken({
        name: SUPER_ADMIN_NAME,
        tokenHash: hash,
        tokenPrefix: prefixOf(token),
        isAdmin: true,
      })
      state.superAdminTokenId = id
    }
  } catch (err) {
    consola.warn("Failed to ensure super-admin row in auth_tokens:", err)
  }

  if (generated) {
    consola.info(`Super admin token: ${token}`)
  }
  consola.info(`Auth: enabled (super admin prefix: ${prefixOf(token)})`)
}
