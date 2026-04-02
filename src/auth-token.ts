#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import {
  generateAuthToken,
  loadAuthToken,
  saveAuthToken,
} from "./lib/auth-token"
import { ensurePaths } from "./lib/paths"

interface RunAuthTokenOptions {
  regenerate: boolean
}

export async function runAuthToken(
  options: RunAuthTokenOptions,
): Promise<void> {
  await ensurePaths()

  if (!options.regenerate) {
    const existing = await loadAuthToken()
    if (existing) {
      consola.info(`Auth token: ${existing}`)
      return
    }
  }

  const token = generateAuthToken()
  await saveAuthToken(token)
  consola.success(`Auth token generated: ${token}`)
}

export const authToken = defineCommand({
  meta: {
    name: "auth-token",
    description: "View or generate the API auth token",
  },
  args: {
    regenerate: {
      type: "boolean",
      default: false,
      description: "Force regenerate the auth token",
    },
  },
  run({ args }) {
    return runAuthToken({
      regenerate: args.regenerate,
    })
  },
})
