import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import {
  captureInfoMessages,
  pickCostNanoAiu,
} from "~/lib/copilot-info-messages"
import { HTTPError } from "~/lib/error"
import {
  imageEditRequestSchema,
  imageGenerationRequestSchema,
  invalidRequest,
  readJson,
} from "~/lib/openai-request"
import { deferUsage, flushUsage, recordUsage } from "~/lib/usage-recorder"
import {
  createImages,
  type ImageOperation,
  type ImagesResponse,
} from "~/services/copilot/create-images"

interface ImageContext {
  operation: ImageOperation
  model: string
}

async function readMultipartEdit(c: Context) {
  let form: FormData
  try {
    form = await c.req.formData()
  } catch (error) {
    if (!(error instanceof TypeError) || c.req.raw.signal.aborted) throw error
    throw invalidRequest("Invalid multipart image edit body")
  }
  let stream: unknown = form.get("stream") ?? undefined
  if (stream === "true") stream = true
  if (stream === "false") stream = false
  const parsed = imageGenerationRequestSchema.safeParse({
    model: form.get("model"),
    prompt: form.get("prompt"),
    stream,
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidRequest(issue.message, issue.path.join("."))
  }
  const images = [...form.getAll("image"), ...form.getAll("image[]")]
  if (
    images.length === 0
    || images.some((file) => !(file instanceof File) || file.size === 0)
  )
    throw invalidRequest("Provide image or image[] file uploads", "image")
  for (const mask of form.getAll("mask")) {
    if (!(mask instanceof File) || mask.size === 0)
      throw invalidRequest("mask must be a non-empty file upload", "mask")
  }
  return { body: form, model: parsed.data.model, stream: parsed.data.stream }
}

async function readImageRequest(c: Context, operation: ImageOperation) {
  const contentType = c.req.header("content-type")?.split(";")[0].trim()
  if (operation === "edits" && contentType === "multipart/form-data")
    return readMultipartEdit(c)
  if (contentType && contentType !== "application/json")
    throw invalidRequest(
      operation === "edits" ?
        "Use application/json or multipart/form-data for image edits"
      : "Use application/json for image generations",
    )
  const schema =
    operation === "edits" ?
      imageEditRequestSchema
    : imageGenerationRequestSchema
  const parsed = schema.safeParse(await readJson(c))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidRequest(
      `Invalid /v1/images/${operation} payload: ${issue.message}`,
      issue.path.join("."),
    )
  }
  return {
    body: parsed.data,
    model: parsed.data.model,
    stream: parsed.data.stream,
  }
}

function captureUsage(
  c: Context,
  response: ImagesResponse,
  context: ImageContext,
) {
  captureInfoMessages(response, {
    endpoint: `/v1/images/${context.operation}`,
    model: response.model ?? context.model,
  })
  const usage = response.usage
  recordUsage(c, {
    model: response.model ?? context.model,
    promptTokens: usage?.input_tokens,
    completionTokens: usage?.output_tokens,
    totalTokens:
      usage?.total_tokens
      ?? ((
        usage?.input_tokens !== undefined && usage.output_tokens !== undefined
      ) ?
        usage.input_tokens + usage.output_tokens
      : undefined),
    costNanoAiu: pickCostNanoAiu(response) ?? undefined,
  })
}

async function readImageResponse(upstream: Response): Promise<ImagesResponse> {
  let response: unknown
  try {
    response = await upstream.json()
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new HTTPError(
      "Upstream returned invalid image JSON",
      new Response(null, { status: 502 }),
    )
  }
  if (
    typeof response !== "object"
    || response === null
    || Array.isArray(response)
  )
    throw new HTTPError(
      "Upstream returned an invalid image response",
      new Response(null, { status: 502 }),
    )
  return response as ImagesResponse
}

function captureImageEvent(
  c: Context,
  event: { data?: string; event?: string },
  context: ImageContext,
): number | undefined {
  if (event.data === undefined || event.data === "[DONE]") return
  const data = JSON.parse(event.data) as ImagesResponse
  captureUsage(c, data, context)
  const type = data.type ?? event.event
  if (type?.endsWith(".completed")) return 200
  if (type === "error" || type?.endsWith(".failed")) return 502
}

export async function handleImages(c: Context, operation: ImageOperation) {
  const payload = await readImageRequest(c, operation)
  const context = { operation, model: payload.model }
  recordUsage(c, { model: payload.model })
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  c.req.raw.signal.addEventListener("abort", onAbort, { once: true })
  if (c.req.raw.signal.aborted) onAbort()
  const cleanup = () => {
    c.req.raw.signal.removeEventListener("abort", onAbort)
    controller.abort()
  }

  let upstream: Response
  try {
    upstream = await createImages(operation, payload.body, controller.signal)
  } catch (error) {
    cleanup()
    throw error
  }
  for (const [name, value] of upstream.headers) {
    if (
      name === "x-request-id"
      || name === "request-id"
      || name === "retry-after"
      || name.startsWith("x-ratelimit-")
    )
      c.header(name, value)
  }

  if (!payload.stream) {
    try {
      const response = await readImageResponse(upstream)
      captureUsage(c, response, context)
      return c.json(response)
    } finally {
      cleanup()
    }
  }

  if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
    await upstream.body?.cancel()
    cleanup()
    throw new HTTPError(
      "Upstream did not return an image event stream",
      new Response(null, { status: 502 }),
    )
  }
  deferUsage(c)
  return streamSSE(c, async (stream) => {
    stream.onAbort(onAbort)
    let terminal = false
    let status = 200
    try {
      for await (const event of events(upstream, controller.signal)) {
        if (controller.signal.aborted) break
        if (event.data === undefined) continue
        const eventStatus = captureImageEvent(c, event, context)
        if (eventStatus !== undefined) {
          terminal = true
          if (eventStatus !== 200) status = eventStatus
        }
        await stream.writeSSE({
          ...event,
          id: event.id?.toString(),
          data: event.data,
        })
      }
      if (!terminal && !controller.signal.aborted)
        throw new Error("Upstream image stream ended before a terminal event")
    } catch (error) {
      status = 502
      consola.error("Upstream image stream failed:", error)
      if (!controller.signal.aborted)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "error",
            code: "upstream_error",
            message: error instanceof Error ? error.message : String(error),
            param: null,
          }),
        })
    } finally {
      if (controller.signal.aborted) status = 499
      cleanup()
      flushUsage(c, status)
    }
  })
}
