import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { sessionMiddleware } from "~/lib/session"
import { state } from "~/lib/state"
import { clearGithubToken } from "~/lib/token"
import {
  cancelFlow,
  getActiveFlow,
  getFlow,
  startDeviceFlow,
} from "~/services/github/device-flow-manager"

export const adminGithubAuthRoutes = new Hono()

adminGithubAuthRoutes.use("*", sessionMiddleware({ requireRole: "super" }))

adminGithubAuthRoutes.get("/status", (c) => {
  const active = getActiveFlow()
  return c.json({
    hasToken: Boolean(state.githubToken),
    login: state.githubLogin ?? null,
    copilotReady: Boolean(state.copilotToken),
    activeFlow:
      active && active.status === "pending" ?
        { id: active.id, expiresAt: active.expiresAt }
      : null,
  })
})

adminGithubAuthRoutes.post("/device-flow/start", async (c) => {
  try {
    const flow = await startDeviceFlow("super")
    return c.json({
      flow_id: flow.id,
      user_code: flow.userCode,
      verification_uri: flow.verificationUri,
      verification_uri_complete: flow.verificationUriComplete ?? null,
      expires_in: Math.max(0, Math.floor((flow.expiresAt - Date.now()) / 1000)),
      interval: flow.intervalSec,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

adminGithubAuthRoutes.get("/device-flow/:id", (c) => {
  const flow = getFlow(c.req.param("id"))
  if (!flow) {
    return c.json(
      { error: { type: "not_found", message: "Flow not found" } },
      404,
    )
  }
  return c.json({
    status: flow.status,
    error: flow.error ?? null,
    login: flow.login ?? null,
    expiresAt: flow.expiresAt,
  })
})

adminGithubAuthRoutes.post("/device-flow/:id/cancel", (c) => {
  cancelFlow(c.req.param("id"))
  return c.json({ ok: true })
})

adminGithubAuthRoutes.post("/logout", async (c) => {
  await clearGithubToken()
  return c.json({ ok: true })
})
