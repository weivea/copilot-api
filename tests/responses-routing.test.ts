import { describe, test, expect, beforeEach } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import {
  shouldUseResponsesEndpoint,
  rebuildWhitelistFromModels,
  recordResponsesOnlyModel,
  resetResponsesRouting,
} from "../src/lib/responses-routing"

const makeModel = (id: string, supported_endpoints?: Array<string>): Model => ({
  id,
  name: id,
  object: "model",
  vendor: "test",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  ...(supported_endpoints ? { supported_endpoints } : {}),
  capabilities: {
    family: id,
    object: "model_capabilities",
    tokenizer: "cl100k_base",
    type: "chat",
    limits: {},
    supports: {},
  },
})

describe("responses-routing", () => {
  beforeEach(() => {
    resetResponsesRouting()
  })

  test("shouldUseResponsesEndpoint returns false for unknown model", () => {
    expect(shouldUseResponsesEndpoint("gpt-4o")).toBe(false)
  })

  test("models with supported_endpoints containing /responses but not /chat/completions are whitelisted", () => {
    rebuildWhitelistFromModels([
      makeModel("gpt-4o"), // legacy: no supported_endpoints
      makeModel("gpt-5.5", ["/responses", "ws:/responses"]),
    ])
    expect(shouldUseResponsesEndpoint("gpt-5.5")).toBe(true)
    expect(shouldUseResponsesEndpoint("gpt-4o")).toBe(false)
  })

  test("dual-stack models (responses + chat/completions) are NOT whitelisted", () => {
    rebuildWhitelistFromModels([
      makeModel("gpt-5.4", [
        "/responses",
        "/chat/completions",
        "ws:/responses",
      ]),
    ])
    expect(shouldUseResponsesEndpoint("gpt-5.4")).toBe(false)
  })

  test("recordResponsesOnlyModel adds to runtime cache", () => {
    expect(shouldUseResponsesEndpoint("gpt-x")).toBe(false)
    recordResponsesOnlyModel("gpt-x")
    expect(shouldUseResponsesEndpoint("gpt-x")).toBe(true)
  })

  test("rebuildWhitelistFromModels does not clear runtime cache", () => {
    recordResponsesOnlyModel("gpt-secret")
    rebuildWhitelistFromModels([makeModel("gpt-4o")])
    expect(shouldUseResponsesEndpoint("gpt-secret")).toBe(true)
  })

  test("rebuildWhitelistFromModels replaces previous static whitelist", () => {
    rebuildWhitelistFromModels([
      makeModel("gpt-5.5", ["/responses", "ws:/responses"]),
    ])
    expect(shouldUseResponsesEndpoint("gpt-5.5")).toBe(true)
    rebuildWhitelistFromModels([makeModel("gpt-4o")])
    expect(shouldUseResponsesEndpoint("gpt-5.5")).toBe(false)
  })
})
