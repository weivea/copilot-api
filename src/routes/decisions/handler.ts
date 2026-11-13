import type { Context } from "hono"

import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
import {
  decisionsRequestSchema,
  invalidRequest,
  readJson,
} from "~/lib/openai-request"
import { getTotalTokens, recordUsage } from "~/lib/usage-recorder"
import { createDecisions } from "~/services/copilot/create-decisions"

export async function handleDecisions(c: Context) {
  const parsed = decisionsRequestSchema.safeParse(await readJson(c))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidRequest(
      `Invalid /v1/decisions payload: ${issue.message}`,
      issue.path.join("."),
    )
  }

  const response = await createDecisions(parsed.data, {
    signal: c.req.raw.signal,
    onResponse: (upstream) => {
      for (const [name, value] of upstream.headers) {
        if (
          name === "x-request-id"
          || name === "request-id"
          || name === "retry-after"
          || name.startsWith("x-ratelimit-")
        )
          c.header(name, value)
      }
    },
  })
  captureInfoMessages(response, {
    endpoint: "/v1/decisions",
    model: response.model ?? parsed.data.model,
  })
  recordUsage(c, {
    model: response.model ?? parsed.data.model,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
    totalTokens: getTotalTokens(response.usage),
    costNanoAiu: pickCostNanoAiu(response),
  })
  return c.json(response)
}
