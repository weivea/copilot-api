import { Hono } from "hono"

import { anthropicErrors } from "~/lib/anthropic-error"
import { forwardError } from "~/lib/error"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()
messageRoutes.use("*", anthropicErrors())

messageRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    return forwardError(c, error, "anthropic")
  }
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return forwardError(c, error, "anthropic")
  }
})
