#!/usr/bin/env node

import consola from "consola"

import { loadAuthToken } from "../lib/auth-token"
import { ensurePaths } from "../lib/paths"

async function main(): Promise<void> {
  await ensurePaths()

  const token = await loadAuthToken()

  if (!token) {
    consola.warn(
      "No auth token found. Run `bun run generate-token` to create one.",
    )
    process.exit(1)
  }

  consola.info(`Auth token: ${token}`)
}

await main()
