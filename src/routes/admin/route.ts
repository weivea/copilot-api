import { Hono } from "hono"

import { adminAuthRoutes } from "./auth"
import { adminGithubAuthRoutes } from "./github-auth"
import { adminTokensRoutes } from "./tokens"
import { adminUsageRoutes } from "./usage"

export const adminRoutes = new Hono()

adminRoutes.route("/", adminAuthRoutes)
adminRoutes.route("/github", adminGithubAuthRoutes)
adminRoutes.route("/tokens", adminTokensRoutes)
adminRoutes.route("/usage", adminUsageRoutes)
