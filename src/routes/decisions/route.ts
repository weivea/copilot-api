import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleDecisions } from "./handler"

export const decisionsRoutes = new Hono()

decisionsRoutes.post("/", async (c) => {
  try {
    return await handleDecisions(c)
  } catch (error) {
    return forwardError(c, error)
  }
})
