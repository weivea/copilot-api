import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  embeddingsRequestSchema,
  invalidRequest,
  readJson,
} from "~/lib/openai-request"
import { normalizeSimpleUsage } from "~/lib/usage-normalizer"
import { recordNormalizedUsage } from "~/lib/usage-recorder"
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

    recordNormalizedUsage(c, {
      model: response.model,
      usage: normalizeSimpleUsage(response.usage, { usageComplete: true }),
    })

    return c.json(response)
  } catch (error) {
    return forwardError(c, error)
  }
})
