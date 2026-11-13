import type { Context } from "hono"

import { z } from "zod"

import { invalidRequest, readJson } from "~/lib/openai-request"
import { state } from "~/lib/state"

const text = z.looseObject({ type: z.literal("text"), text: z.string() })
const image = z.looseObject({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.looseObject({
      type: z.literal("base64"),
      media_type: z.enum([
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
      ]),
      data: z.string(),
    }),
    z.looseObject({ type: z.literal("url"), url: z.string() }),
  ]),
})
const toolUse = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})
const toolResult = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.union([text, image]))]).optional(),
  is_error: z.boolean().optional(),
})
const thinking = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
})

const envelope = z.looseObject({
  model: z.string().min(1),
  messages: z
    .array(
      z.looseObject({
        role: z.enum(["user", "assistant"]),
        content: z.union([
          z.string(),
          z.array(z.looseObject({ type: z.string().min(1) })),
        ]),
      }),
    )
    .min(1),
  max_tokens: z.number().int().nonnegative().optional(),
  stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(text)]).optional(),
  tools: z.array(z.looseObject({})).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().nonnegative().optional(),
  stop_sequences: z.array(z.string()).optional(),
})

export type NativeMessagesPayload = z.infer<typeof envelope>

const translated = envelope.extend({
  messages: z
    .array(
      z.discriminatedUnion("role", [
        z.looseObject({
          role: z.literal("user"),
          content: z.union([
            z.string(),
            z.array(z.union([text, image, toolResult])),
          ]),
        }),
        z.looseObject({
          role: z.literal("assistant"),
          content: z.union([
            z.string(),
            z.array(z.union([text, toolUse, thinking])),
          ]),
        }),
      ]),
    )
    .min(1),
  tools: z
    .array(
      z.looseObject({
        name: z.string().min(1),
        description: z.string().optional(),
        input_schema: z.record(z.string(), z.unknown()),
        strict: z.boolean().optional(),
      }),
    )
    .optional(),
  tool_choice: z
    .looseObject({
      type: z.enum(["auto", "any", "tool", "none"]),
      name: z.string().optional(),
      disable_parallel_tool_use: z.boolean().optional(),
    })
    .refine((choice) => choice.type !== "tool" || Boolean(choice.name), {
      message: "tool_choice.name is required when type is tool",
    })
    .optional(),
  thinking: z
    .looseObject({
      type: z.enum(["enabled", "disabled", "adaptive"]),
      budget_tokens: z.number().int().positive().optional(),
    })
    .refine(
      (value) => value.type !== "enabled" || value.budget_tokens !== undefined,
      {
        message: "thinking.budget_tokens is required when thinking is enabled",
      },
    )
    .optional(),
  metadata: z.looseObject({ user_id: z.string().optional() }).optional(),
  output_config: z
    .looseObject({
      effort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional(),
    })
    .optional(),
  max_tokens: z.number().int().nonnegative().default(0),
})

function validationError(error: z.ZodError): never {
  const issue = error.issues[0]
  throw invalidRequest(
    `${issue.path.join(".")}: ${issue.message}`,
    issue.path.join("."),
  )
}

export async function readMessagesPayload(c: Context, countTokens = false) {
  const result = envelope.safeParse(await readJson(c))
  if (!result.success) return validationError(result.error)
  if (!countTokens && result.data.max_tokens === undefined)
    throw invalidRequest("max_tokens is required", "max_tokens")
  return result.data
}

export function translatedMessagesPayload(payload: NativeMessagesPayload) {
  const result = translated.safeParse(payload)
  if (!result.success) return validationError(result.error)
  if (result.data.thinking?.type === "adaptive")
    throw invalidRequest(
      "Adaptive thinking requires native Messages support",
      "thinking",
    )
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(translated.shape, key) || key === "top_k")
      throw invalidRequest(
        `${key} requires a model with native Messages support`,
        key,
      )
  }
  if (
    typeof payload.output_config === "object"
    && payload.output_config !== null
    && "format" in payload.output_config
  )
    throw invalidRequest(
      "output_config.format requires native Messages support",
      "output_config.format",
    )
  if (
    result.data.tools?.some((tool) => "type" in tool && tool.type !== "custom")
  )
    throw invalidRequest(
      "Server-side tools require native Messages support",
      "tools",
    )
  return result.data
}

export function resolveMessagesModel(model: string): string {
  if (state.models?.data.some((candidate) => candidate.id === model))
    return model
  const withoutDate = model.replace(/-(?:\d{8}|latest)$/, "")
  const dotted = withoutDate.replace(/-(\d+)-(\d+)(?=-|$)/, "-$1.$2")
  return (
    state.models?.data.find(
      (candidate) => candidate.id === withoutDate || candidate.id === dotted,
    )?.id ?? model
  )
}

export function supportsNativeMessages(model: string): boolean {
  return (
    state.models?.data
      .find((candidate) => candidate.id === model)
      ?.supported_endpoints?.some(
        (path) => path === "/v1/messages" || path === "/messages",
      ) ?? false
  )
}

export function forwardMessagesHeaders(c: Context, response: Response): void {
  for (const [name, value] of response.headers) {
    if (
      name === "request-id"
      || name === "x-request-id"
      || name === "retry-after"
      || name.startsWith("anthropic-ratelimit-")
    )
      c.header(name, value)
  }
}
