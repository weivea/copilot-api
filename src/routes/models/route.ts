import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

function publicModel(model: Model) {
  return {
    id: model.id,
    object: "model",
    type: "model",
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: model.vendor,
    display_name: model.name,
  }
}

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => publicModel(model))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})

modelRoutes.get("/:model", async (c) => {
  try {
    if (!state.models) await cacheModels()
    const id = c.req.param("model")
    const model = state.models?.data.find((item) => item.id === id)
    if (!model)
      return c.json(
        {
          error: {
            message: `Model '${id}' does not exist or is not available`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found",
          },
        },
        404,
      )
    return c.json(publicModel(model))
  } catch (error) {
    return forwardError(c, error)
  }
})
