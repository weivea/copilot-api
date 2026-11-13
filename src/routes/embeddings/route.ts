import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  embeddingsRequestSchema,
  invalidRequest,
  readJson,
} from "~/lib/openai-request"
import { recordUsage } from "~/lib/usage-recorder"
import { createEmbeddings } from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const parsed = embeddingsRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw invalidRequest(issue.message, issue.path.join("."))
    }
    const payload = parsed.data
    const response = await createEmbeddings(payload)

    recordUsage(c, {
      model: response.model,
      promptTokens: response.usage.prompt_tokens,
      completionTokens: null,
      totalTokens: response.usage.total_tokens,
    })

    return c.json(response)
  } catch (error) {
    return forwardError(c, error)
  }
})
