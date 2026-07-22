import type { Context } from "hono"

import consola from "consola"
import { z } from "zod"

import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
import { HTTPError } from "~/lib/error"
import { deferUsage, flushUsage, recordUsage } from "~/lib/usage-recorder"
import {
  createResponses,
  type ResponsesCompletedEvent,
  type ResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/create-responses"

interface StreamCaptureState {
  cost: number | null
  model: string | null
  usage: { input: number; output: number; total: number }
}

function captureFromCompletedEvent(
  evt: { event?: string; data?: string },
  capture: StreamCaptureState,
): void {
  if (
    (evt.event !== "response.completed" && evt.event !== "response.incomplete")
    || !evt.data
  )
    return
  try {
    const parsed = JSON.parse(evt.data) as ResponsesCompletedEvent
    if (!parsed.response) return
    captureInfoMessages(parsed, {
      endpoint: "/v1/responses",
      model: parsed.response.model,
    })
    captureInfoMessages(parsed.response, {
      endpoint: "/v1/responses",
      model: parsed.response.model,
    })
    const cost = pickCostNanoAiu(parsed) ?? pickCostNanoAiu(parsed.response)
    if (cost !== null) capture.cost = cost
    capture.usage.input =
      parsed.response.usage?.input_tokens ?? capture.usage.input
    capture.usage.output =
      parsed.response.usage?.output_tokens ?? capture.usage.output
    capture.usage.total =
      parsed.response.usage?.total_tokens ?? capture.usage.total
    capture.model = parsed.response.model
  } catch {
    /* best-effort; never break pass-through on parse failure */
  }
}

const requestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.any())]),
    background: z.boolean().nullish(),
    include: z.array(z.string()).nullish(),
    instructions: z.string().nullish(),
    stream: z.boolean().nullish(),
    store: z.boolean().nullish(),
    previous_response_id: z.string().nullish(),
    frequency_penalty: z.number().nullish(),
    max_output_tokens: z.number().int().nullish(),
    max_tool_calls: z.number().int().nullish(),
    presence_penalty: z.number().nullish(),
    temperature: z.number().nullish(),
    top_logprobs: z.number().int().nullish(),
    top_p: z.number().nullish(),
    stop: z.union([z.string(), z.array(z.string())]).nullish(),
    tools: z.array(z.any()).nullish(),
    tool_choice: z.any().nullish(),
    reasoning: z.any().nullish(),
    modalities: z.array(z.string()).nullish(),
    metadata: z.record(z.string(), z.string()).nullish(),
    prompt_cache_key: z.string().nullish(),
    prompt_cache_retention: z.string().nullish(),
    safety_identifier: z.string().nullish(),
    service_tier: z.string().nullish(),
    text: z.any().nullish(),
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
  if (body.store === true || body.background === true) {
    const field = body.background === true ? "background" : "store"
    return c.json(
      {
        error: {
          message: `${field}: true is not supported by this stateless proxy`,
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
  const onAbort = () => upstreamController.abort()
  c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

  const upstream = await createResponses(payload, {
    signal: upstreamController.signal,
  })

  if (payload.stream) {
    const capture: StreamCaptureState = {
      cost: null,
      model: null,
      usage: { input: 0, output: 0, total: 0 },
    }
    deferUsage(c)

    // Pass-through SSE: serialise each event back into the SSE wire format.
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          try {
            for await (const evt of upstream as AsyncIterable<{
              event?: string
              data?: string
              id?: string
              retry?: number
            }>) {
              captureFromCompletedEvent(evt, capture)
              if (evt.id !== undefined)
                controller.enqueue(encoder.encode(`id: ${evt.id}\n`))
              if (evt.event)
                controller.enqueue(encoder.encode(`event: ${evt.event}\n`))
              if (evt.retry !== undefined)
                controller.enqueue(encoder.encode(`retry: ${evt.retry}\n`))
              if (evt.data !== undefined)
                controller.enqueue(encoder.encode(`data: ${evt.data}\n\n`))
            }
          } catch (error) {
            consola.error("Upstream /responses stream failed:", error)
            const message =
              error instanceof Error ? error.message : String(error)
            controller.enqueue(
              encoder.encode(
                `event: response.error\ndata: ${JSON.stringify({ error: { message } })}\n\n`,
              ),
            )
          } finally {
            c.req.raw.signal.removeEventListener("abort", onAbort)
            recordUsage(c, {
              model: capture.model,
              promptTokens: capture.usage.input || null,
              completionTokens: capture.usage.output || null,
              totalTokens: capture.usage.total || null,
              costNanoAiu: capture.cost,
            })
            flushUsage(c)
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

  c.req.raw.signal.removeEventListener("abort", onAbort)

  if (upstream instanceof Response) {
    // defensive — createResponses normally returns parsed JSON or AsyncIterable
    throw new HTTPError("Unexpected upstream response type", upstream)
  }

  const resp = upstream as ResponsesResponse
  captureInfoMessages(resp, {
    endpoint: "/v1/responses",
    model: resp.model,
  })
  recordUsage(c, {
    model: resp.model,
    promptTokens: resp.usage?.input_tokens ?? null,
    completionTokens: resp.usage?.output_tokens ?? null,
    totalTokens: resp.usage?.total_tokens ?? null,
    costNanoAiu: pickCostNanoAiu(resp),
  })
  return c.json(resp)
}
