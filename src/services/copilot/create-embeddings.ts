import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

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

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  const result = (await response.json()) as UpstreamEmbeddingResponse
  return {
    ...result,
    object: result.object ?? "list",
    model: result.model ?? payload.model,
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
