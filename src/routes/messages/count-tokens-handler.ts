import type { Context } from "hono"

import consola from "consola"
import { z } from "zod"

import type { Model } from "~/services/copilot/get-models"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { recordUsage } from "~/lib/usage-recorder"
import { cacheModels } from "~/lib/utils"
import { createMessages } from "~/services/copilot/create-messages"

import { translateToOpenAI } from "./non-stream-translation"
import {
  forwardMessagesHeaders,
  readMessagesPayload,
  resolveMessagesModel,
  translatedMessagesPayload,
  type NativeMessagesPayload,
} from "./request"

const tokenCountSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
})

function isUnavailableCountEndpoint(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  if (![404, 405, 501].includes(error.response.status)) return false
  return !/model_not_found|unknown model|model.+not found/i.test(
    error.bodyText ?? "",
  )
}

async function nativeTokenCount(c: Context, payload: NativeMessagesPayload) {
  try {
    const result = await createMessages<unknown>(payload, {
      endpoint: "/v1/messages/count_tokens",
      stream: false,
      initiator: "user",
      signal: c.req.raw.signal,
      anthropicVersion: c.req.header("anthropic-version"),
      anthropicBeta: c.req.header("anthropic-beta"),
      onResponse: (response) => forwardMessagesHeaders(c, response),
    })
    const parsed = tokenCountSchema.safeParse(result)
    if (!parsed.success)
      throw new HTTPError(
        "Upstream returned an invalid token count",
        new Response(null, { status: 502 }),
      )
    return parsed.data
  } catch (error) {
    if (!isUnavailableCountEndpoint(error)) throw error
    consola.warn("Native token counting is unavailable; using a local estimate")
    return undefined
  }
}

async function estimateTokens(
  c: Context,
  payload: NativeMessagesPayload,
  selectedModel: Model,
) {
  const translated = translatedMessagesPayload(payload)
  const tokenCount = await getTokenCount(
    translateToOpenAI(translated),
    selectedModel,
  )
  const beta = c.req.header("anthropic-beta")
  const mcpTools =
    beta?.startsWith("claude-code")
    && translated.tools?.some((tool) => tool.name.startsWith("mcp__"))
  if (translated.tools?.length && !mcpTools) {
    if (payload.model.startsWith("claude")) tokenCount.input += 346
    else if (payload.model.startsWith("grok")) tokenCount.input += 480
  }
  let multiplier = 1
  if (payload.model.startsWith("claude")) multiplier = 1.15
  else if (payload.model.startsWith("grok")) multiplier = 1.03
  return {
    input_tokens: Math.round(
      (tokenCount.input + tokenCount.output) * multiplier,
    ),
  }
}

export async function handleCountTokens(c: Context) {
  // Counting is non-billable, including requests that fail upstream.
  recordUsage(c, { billable: false })
  const payload = await readMessagesPayload(c, true)
  if (!state.models) await cacheModels()
  payload.model = resolveMessagesModel(payload.model)
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  if (!selectedModel)
    throw new HTTPError(
      `Unknown model: ${payload.model}`,
      new Response(null, { status: 404 }),
    )
  const native = await nativeTokenCount(c, payload)
  const result = native ?? (await estimateTokens(c, payload, selectedModel))
  c.header("x-token-count-estimated", native ? "false" : "true")
  recordUsage(c, {
    model: payload.model,
    promptTokens: result.input_tokens,
    totalTokens: result.input_tokens,
    billable: false,
  })
  return c.json(result)
}
