import { Buffer } from "node:buffer"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

function invalidEmbeddingResponse(): never {
  throw new HTTPError(
    "Upstream returned an invalid embedding vector",
    new Response(null, { status: 502 }),
  )
}

function normalizeEmbedding(
  embedding: unknown,
  format: "float" | "base64",
): Array<number> | string {
  if (Array.isArray(embedding)) {
    if (
      embedding.length === 0
      || !embedding.every(
        (value: unknown): value is number =>
          typeof value === "number" && Number.isFinite(value),
      )
    )
      return invalidEmbeddingResponse()
    const vector = embedding
    if (format === "float") return vector
    const bytes = Buffer.alloc(vector.length * 4)
    for (const [index, value] of vector.entries())
      bytes.writeFloatLE(value, index * 4)
    return bytes.toString("base64")
  }
  if (typeof embedding !== "string" || embedding.length === 0)
    return invalidEmbeddingResponse()
  const bytes = Buffer.from(embedding, "base64")
  if (bytes.length % 4 !== 0 || bytes.toString("base64") !== embedding)
    return invalidEmbeddingResponse()
  const vector = Array.from({ length: bytes.length / 4 }, (_, index) =>
    bytes.readFloatLE(index * 4),
  )
  if (!vector.every((value) => Number.isFinite(value)))
    return invalidEmbeddingResponse()
  return format === "base64" ? embedding : vector
}

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")
  // convert single string input to array for uniform processing
  const normalizedPayload: EmbeddingRequest = {
    ...payload,
    input: typeof payload.input === "string" ? [payload.input] : payload.input,
  }
  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(normalizedPayload),
  })

  if (!response.ok)
    throw new HTTPError(
      "Failed to create embeddings",
      response,
      await response.text(),
    )

  const result = (await response.json()) as UpstreamEmbeddingResponse
  if (!Array.isArray(result.data)) return invalidEmbeddingResponse()
  return {
    ...result,
    object: result.object ?? "list",
    model: result.model ?? payload.model,
    data: result.data.map((item) => ({
      ...item,
      embedding: normalizeEmbedding(
        item.embedding,
        payload.encoding_format ?? "float",
      ),
    })),
  }
}

export interface EmbeddingRequest {
  input: string | Array<string> | Array<number> | Array<Array<number>>
  model: string
  dimensions?: number
  encoding_format?: "float" | "base64"
  user?: string
}

export interface Embedding {
  object: string
  embedding: Array<number> | string
  index: number
}

export interface EmbeddingResponse {
  object: "list"
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

type UpstreamEmbeddingResponse = Omit<EmbeddingResponse, "model" | "object"> & {
  object?: "list"
  model?: string
}
