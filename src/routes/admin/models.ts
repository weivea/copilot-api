import { Hono } from "hono"

import { sessionMiddleware } from "~/lib/session"
import { state } from "~/lib/state"

export const adminModelsRoutes = new Hono()

adminModelsRoutes.use("*", sessionMiddleware())

adminModelsRoutes.get("/", (c) => {
  if (!state.models) {
    return c.json({ available: false, data: [] as Array<unknown> })
  }
  return c.json({ available: true, data: state.models.data })
})
