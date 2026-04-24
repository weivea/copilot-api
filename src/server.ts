import { Hono } from "hono"
import { cors } from "hono/cors"
import path from "node:path"

import { authMiddleware } from "./lib/auth-middleware"
import { redactingLogger } from "./lib/redacting-logger"
import { staticSpa } from "./lib/static-spa"
import { usageRecorder } from "./lib/usage-recorder"
import { adminRoutes } from "./routes/admin/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { tokenRoute } from "./routes/token/route"

export const server = new Hono()

server.use(redactingLogger())
server.use(cors())

server.get("/healthz", (c) => c.text("ok"))

server.route("/admin/api", adminRoutes)

server.use(authMiddleware())
server.use(usageRecorder())

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/token", tokenRoute)

server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/messages", messageRoutes)

const SPA_ROOT = path.resolve(import.meta.dir, "..", "dist", "public")
server.use(staticSpa(SPA_ROOT))
