#!/usr/bin/env node

import consola from "consola"

import { generateAuthToken, saveAuthToken } from "../lib/auth-token"
import { ensurePaths } from "../lib/paths"

async function main(): Promise<void> {
  await ensurePaths()

  const token = generateAuthToken()
  await saveAuthToken(token)

  consola.success(`Auth token generated: ${token}`)
}

await main()
