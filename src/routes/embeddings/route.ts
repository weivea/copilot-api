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

    recordUsage(c, {
      model: response.model ?? payload.model,
      promptTokens: response.usage.prompt_tokens,
      completionTokens: null,
      totalTokens: response.usage.total_tokens,
    })

    return c.json(response)
  } catch (error) {
    return forwardError(c, error)
  }
})
