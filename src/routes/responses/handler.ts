import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
import { HTTPError } from "~/lib/error"
import { invalidRequest, readJson } from "~/lib/openai-request"
import { normalizeResponsesUsage } from "~/lib/usage-normalizer"
import {
  deferUsage,
  flushUsage,
  recordNormalizedUsage,
} from "~/lib/usage-recorder"
import {
  createResponses,
  type ResponsesCompletedEvent,
  type ResponsesPayload,
  type ResponsesResponse,
} from "~/services/copilot/create-responses"

interface StreamCaptureState {
  cost: number | null
  model: string | null
  usage: ResponsesResponse["usage"] | undefined
  hasFinalUsage: boolean
}

type RawResponsesEvent = {
  event?: string
  data?: string
  id?: string
  retry?: number
}

function classifyResponsesEvent(eventName: string | undefined): {
  terminal: boolean
  failed: boolean
} {
  if (
    eventName === "error"
    || eventName === "response.error"
    || eventName === "response.failed"
  ) {
    return { terminal: true, failed: true }
  }
  if (
    eventName === "response.completed"
    || eventName === "response.incomplete"
  ) {
    return { terminal: true, failed: false }
  }
  return { terminal: false, failed: false }
}

interface PipeResponsesArgs {
  c: Context
  upstream: AsyncIterable<RawResponsesEvent>
  upstreamController: AbortController
  onAbort: () => void
  capture: StreamCaptureState
}

async function consumeResponsesEvents(
  stream: {
    writeSSE: (msg: RawResponsesEvent & { data: string }) => Promise<void>
  },
  args: PipeResponsesArgs,
): Promise<{ terminal: boolean; failed: boolean }> {
  let terminal = false
  let failed = false
  for await (const evt of args.upstream) {
    if (args.upstreamController.signal.aborted) break
    captureFromStreamEvent(evt, args.capture)
    const cls = classifyResponsesEvent(evt.event)
    if (cls.terminal) terminal = true
    if (cls.failed) failed = true
    if (evt.data !== undefined) {
      await stream.writeSSE({ ...evt, data: evt.data })
    }
  }
  return { terminal, failed }
}

async function pipeResponsesStream(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  args: PipeResponsesArgs,
): Promise<void> {
  const { c, upstreamController, onAbort, capture } = args
  const isAborted = () =>
    upstreamController.signal.aborted || c.req.raw.signal.aborted
  stream.onAbort(onAbort)
  let terminal = false
  let status = 200
  try {
    const res = await consumeResponsesEvents(stream, args)
    terminal = res.terminal
    if (res.failed) status = 502
    if (!terminal && !upstreamController.signal.aborted) {
      throw new Error("Upstream Responses stream ended before a terminal event")
    }
  } catch (error) {
    status = isAborted() ? 499 : 502
    consola.error("Upstream /responses stream failed:", error)
    const message = error instanceof Error ? error.message : String(error)
    if (!upstreamController.signal.aborted) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          type: "error",
          code: "upstream_error",
          message,
          param: null,
        }),
      })
    }
  } finally {
    if (!terminal && isAborted()) status = 499
    upstreamController.abort()
    c.req.raw.signal.removeEventListener("abort", onAbort)
    recordNormalizedUsage(c, {
      model: capture.model,
      usage: normalizeResponsesUsage(capture.usage, {
        usageComplete: capture.hasFinalUsage && status === 200,
      }),
      costNanoAiu: capture.cost,
    })
    flushUsage(c, status)
  }
}

function captureFromStreamEvent(
  evt: { event?: string; data?: string },
  capture: StreamCaptureState,
): void {
  if (
    evt.event !== "response.completed"
    && evt.event !== "response.incomplete"
    && evt.event !== "response.failed"
  )
    return
  if (!evt.data) return
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
    if (parsed.response.usage) {
      capture.usage = parsed.response.usage
      if (evt.event !== "response.failed") {
        capture.hasFinalUsage = true
      }
    }
    capture.model = parsed.response.model
  } catch {
    /* best-effort; never break pass-through on parse failure */
  }
}

const requestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([
      z.string(),
      z.array(
        z.looseObject({
          type: z.string().optional(),
          role: z.enum(["user", "assistant", "system", "developer"]).optional(),
          content: z
            .union([
              z.string(),
              z.array(
                z.looseObject({
                  type: z.string(),
                }),
              ),
            ])
            .optional(),
        }),
      ),
    ]),
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
  const raw = await readJson(c)
  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidRequest(
      `Invalid /v1/responses payload: ${issue.message}`,
      issue.path.join("."),
    )
  }

  const payload = parsed.data as ResponsesPayload

  const upstreamController = new AbortController()
  const onAbort = () => upstreamController.abort()
  c.req.raw.signal.addEventListener("abort", onAbort, { once: true })

  if (c.req.raw.signal.aborted) upstreamController.abort()
  let upstream: Awaited<ReturnType<typeof createResponses>>
  try {
    upstream = await createResponses(payload, {
      signal: upstreamController.signal,
    })
  } catch (error) {
    c.req.raw.signal.removeEventListener("abort", onAbort)
    throw error
  }

  if (payload.stream) {
    const capture: StreamCaptureState = {
      cost: null,
      model: payload.model,
      usage: undefined,
      hasFinalUsage: false,
    }
    deferUsage(c)

    // Pass-through SSE: serialise each event back into the SSE wire format.
    return streamSSE(
      c,
      (stream) =>
        pipeResponsesStream(stream, {
          c,
          upstream: upstream as AsyncIterable<RawResponsesEvent>,
          upstreamController,
          onAbort,
          capture,
        }),
      (error) => {
        consola.error("Responses stream write failed:", error)
        return Promise.resolve()
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
  recordNormalizedUsage(c, {
    model: resp.model,
    usage: normalizeResponsesUsage(resp.usage, {
      usageComplete: resp.usage !== undefined,
    }),
    costNanoAiu: pickCostNanoAiu(resp),
  })
  return c.json(resp)
}
