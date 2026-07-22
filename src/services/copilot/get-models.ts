import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_non_streaming_output_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  vision?: boolean
  prediction?: boolean
  thinking?: boolean
  adaptive_thinking?: boolean
  structured_outputs?: boolean
  tool_search?: boolean
  context_editing?: boolean
  max_thinking_budget?: number
  min_thinking_budget?: number
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  limits?: ModelLimits | null
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  model_picker_category?: string
  model_picker_price_category?: string
  name: string
  object: string
  preview?: boolean
  vendor: string
  version: string
  is_chat_default?: boolean
  is_chat_fallback?: boolean
  supported_endpoints?: Array<
    | "/chat/completions"
    | "/responses"
    | "ws:/responses"
    | "/v1/messages"
    | (string & {})
  >
  warning_messages?: Array<{ code: string; message: string }>
  info_messages?: Array<{ code: string; message: string }>
  billing?: {
    is_premium?: boolean
    multiplier?: number
    restricted_to?: Array<string>
    token_prices?: Record<string, unknown>
    promo?: {
      id: string
      discount_percent: number
      ends_at: string
      message: string
    }
  }
  policy?: {
    state: string
    terms: string
  }
}
