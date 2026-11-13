import type { Context } from "hono"

import { z } from "zod"

import { HTTPError } from "./error"

export function invalidRequest(message: string, param: string | null = null) {
  return new HTTPError(
    message,
    new Response(null, { status: 400 }),
    JSON.stringify({
      error: { message, type: "invalid_request_error", param, code: null },
    }),
  )
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json<unknown>()
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw invalidRequest("Invalid JSON in request body")
  }
}

const textPart = z.looseObject({ type: z.literal("text"), text: z.string() })
const imagePart = z.looseObject({
  type: z.literal("image_url"),
  image_url: z.looseObject({
    url: z.string(),
    detail: z.enum(["low", "high", "auto"]).optional(),
  }),
})
const toolCall = z.looseObject({
  id: z.string(),
  type: z.literal("function"),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
})

export const embeddingsRequestSchema = z.looseObject({
  model: z.string().min(1),
  input: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1),
    z.array(z.number().int().nonnegative()).min(1),
    z.array(z.array(z.number().int().nonnegative()).min(1)).min(1),
  ]),
  dimensions: z.number().int().positive().optional(),
  encoding_format: z.enum(["float", "base64"]).optional(),
  user: z.string().optional(),
})

export const chatRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z
    .array(
      z
        .looseObject({
          role: z.enum(["system", "developer", "user", "assistant", "tool"]),
          content: z
            .union([z.string(), z.array(z.union([textPart, imagePart]))])
            .nullish(),
          name: z.string().optional(),
          tool_calls: z.array(toolCall).optional(),
          tool_call_id: z.string().optional(),
        })
        .superRefine((message, ctx) => {
          if (
            message.role !== "assistant"
            && (message.content === null || message.content === undefined)
          ) {
            ctx.addIssue({
              code: "custom",
              message: "content is required",
              path: ["content"],
            })
          }
          if (message.role === "tool" && !message.tool_call_id) {
            ctx.addIssue({
              code: "custom",
              message: "tool_call_id is required",
              path: ["tool_call_id"],
            })
          }
        }),
    )
    .min(1),
  stream: z.boolean().nullish(),
  stream_options: z
    .looseObject({ include_usage: z.boolean().optional() })
    .nullish(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  n: z.number().int().positive().nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
  tools: z
    .array(
      z.looseObject({
        type: z.literal("function"),
        function: z.looseObject({
          name: z.string().min(1),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).default({}),
          strict: z.boolean().nullish(),
        }),
      }),
    )
    .nullish(),
  tool_choice: z
    .union([
      z.enum(["none", "auto", "required"]),
      z.looseObject({
        type: z.literal("function"),
        function: z.looseObject({ name: z.string() }),
      }),
    ])
    .nullish(),
  parallel_tool_calls: z.boolean().nullish(),
})
