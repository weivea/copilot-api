import { Hono } from "hono"

import { adminAuthRoutes } from "./auth"
import { adminCertificateRoutes } from "./certificate"
import { adminGithubAuthRoutes } from "./github-auth"
import { adminModelsRoutes } from "./models"
import { adminTokensRoutes } from "./tokens"
import { adminUsageRoutes } from "./usage"

export const adminRoutes = new Hono()

adminRoutes.route("/", adminAuthRoutes)
adminRoutes.route("/certificate", adminCertificateRoutes)
adminRoutes.route("/github", adminGithubAuthRoutes)
adminRoutes.route("/models", adminModelsRoutes)
adminRoutes.route("/tokens", adminTokensRoutes)
adminRoutes.route("/usage", adminUsageRoutes)
