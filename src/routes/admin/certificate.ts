import { Hono } from "hono"

import { readCertificateInfo } from "~/lib/certificate"
import { forwardError } from "~/lib/error"
import { sessionMiddleware } from "~/lib/session"

export const adminCertificateRoutes = new Hono()

adminCertificateRoutes.use("*", sessionMiddleware({ requireRole: "super" }))

adminCertificateRoutes.get("/", async (c) => {
  try {
    const info = await readCertificateInfo()
    return c.json(info)
  } catch (error) {
    return forwardError(c, error)
  }
})
