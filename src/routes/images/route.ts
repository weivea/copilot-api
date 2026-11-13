import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleImages } from "./handler"

export const imageRoutes = new Hono()

for (const operation of ["generations", "edits"] as const) {
  imageRoutes.post(`/${operation}`, async (c) => {
    try {
      return await handleImages(c, operation)
    } catch (error) {
      return forwardError(c, error)
    }
  })
}
