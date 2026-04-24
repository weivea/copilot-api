import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { recordUsage } from "~/lib/usage-recorder"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    const response = await createEmbeddings(payload)

    const anyResp = response as {
      model?: string
      usage?: { prompt_tokens?: number; total_tokens?: number }
    }
    recordUsage(c, {
      model: anyResp.model ?? (payload as { model?: string }).model ?? null,
      promptTokens: anyResp.usage?.prompt_tokens ?? null,
      completionTokens: null,
      totalTokens: anyResp.usage?.total_tokens ?? null,
    })

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
