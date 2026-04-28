import type { Context } from "hono"

import { z } from "zod"

import { HTTPError } from "~/lib/error"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const requestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.any())]),
    instructions: z.string().nullish(),
    stream: z.boolean().nullish(),
    store: z.boolean().nullish(),
    previous_response_id: z.string().nullish(),
    max_output_tokens: z.number().int().nullish(),
    temperature: z.number().nullish(),
    top_p: z.number().nullish(),
    stop: z.union([z.string(), z.array(z.string())]).nullish(),
    tools: z.array(z.any()).nullish(),
    tool_choice: z.any().nullish(),
    reasoning: z.any().nullish(),
    modalities: z.array(z.string()).nullish(),
    metadata: z.record(z.string(), z.string()).nullish(),
    user: z.string().nullish(),
    truncation: z.enum(["auto", "disabled"]).nullish(),
  })
  .loose()

export async function handleResponses(c: Context) {
  const raw = await c.req.json<unknown>()
  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          message: `Invalid /v1/responses payload: ${parsed.error.message}`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const body = parsed.data
  if (body.previous_response_id) {
    return c.json(
      {
        error: {
          message:
            "previous_response_id is not supported by this proxy (server-side conversation state is disabled)",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  // Force store: false; we don't want Copilot to retain state on our behalf.
  const payload: ResponsesPayload = {
    ...(body as ResponsesPayload),
    store: false,
  }

  const upstreamController = new AbortController()
  c.req.raw.signal.addEventListener("abort", () => upstreamController.abort())

  const upstream = await createResponses(payload, {
    signal: upstreamController.signal,
  })

  if (payload.stream) {
    // Pass-through SSE: serialise each event back into the SSE wire format.
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          try {
            for await (const evt of upstream as AsyncIterable<{
              event?: string
              data?: string
            }>) {
              if (evt.event)
                controller.enqueue(encoder.encode(`event: ${evt.event}\n`))
              if (evt.data !== undefined)
                controller.enqueue(encoder.encode(`data: ${evt.data}\n\n`))
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            controller.enqueue(
              encoder.encode(
                `event: response.error\ndata: ${JSON.stringify({ error: { message } })}\n\n`,
              ),
            )
          } finally {
            controller.close()
          }
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    )
  }

  if (upstream instanceof Response) {
    // defensive — createResponses normally returns parsed JSON or AsyncIterable
    throw new HTTPError("Unexpected upstream response type", upstream)
  }

  return c.json(upstream)
}
