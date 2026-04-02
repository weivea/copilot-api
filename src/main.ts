#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { authToken } from "./auth-token"
import { checkUsage } from "./check-usage"
import { debug } from "./debug"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "copilot-api",
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: {
    auth,
    start,
    "check-usage": checkUsage,
    "auth-token": authToken,
    debug,
  },
})

await runMain(main)
