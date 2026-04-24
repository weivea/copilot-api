#!/usr/bin/env node

import consola from "consola"

import {
  createAuthToken,
  findAuthTokenByName,
  rotateAuthTokenSecret,
  updateAuthToken,
} from "../db/queries/auth-tokens"
import { generateAuthToken, saveAuthToken } from "../lib/auth-token"
import { hashToken, prefixOf } from "../lib/auth-token-utils"
import { ensurePaths } from "../lib/paths"

const SUPER_ADMIN_NAME = "__super_admin__"

async function main(): Promise<void> {
  await ensurePaths()

  const token = generateAuthToken()
  await saveAuthToken(token)

  const hash = hashToken(token)
  const prefix = prefixOf(token)

  const existing = await findAuthTokenByName(SUPER_ADMIN_NAME)
  if (existing) {
    await rotateAuthTokenSecret(existing.id, hash, prefix)
    if (existing.isAdmin !== 1 || existing.isDisabled !== 0) {
      await updateAuthToken(existing.id, {
        isAdmin: true,
        isDisabled: false,
      })
    }
  } else {
    await createAuthToken({
      name: SUPER_ADMIN_NAME,
      tokenHash: hash,
      tokenPrefix: prefix,
      isAdmin: true,
    })
  }

  consola.success(`Auth token generated: ${token}`)
}

await main()
