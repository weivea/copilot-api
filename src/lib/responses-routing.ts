import type { Model } from "~/services/copilot/get-models"

let staticWhitelist: Set<string> = new Set()
const runtimeCache: Set<string> = new Set()

export function shouldUseResponsesEndpoint(modelId: string): boolean {
  return staticWhitelist.has(modelId) || runtimeCache.has(modelId)
}

export function rebuildWhitelistFromModels(models: Array<Model>): void {
  const next = new Set<string>()
  for (const model of models) {
    const endpoints = (model as Model & { supported_endpoints?: Array<string> })
      .supported_endpoints
    if (!Array.isArray(endpoints)) continue
    if (
      endpoints.includes("/responses")
      && !endpoints.includes("/chat/completions")
    ) {
      next.add(model.id)
    }
  }
  staticWhitelist = next
}

export function recordResponsesOnlyModel(modelId: string): void {
  runtimeCache.add(modelId)
}

// Test-only helper. Do not call from production code paths.
export function resetResponsesRouting(): void {
  staticWhitelist = new Set()
  runtimeCache.clear()
}
