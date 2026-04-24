import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

/**
 * Format an error with its full `cause` chain. Bun's fetch attaches socket
 * errors (UND_ERR_SOCKET, ECONNRESET, etc.) on `error.cause` — without
 * walking the chain those root causes never make it into the logs.
 */
export function formatErrorWithCause(error: unknown): string {
  const parts: Array<string> = []
  let current: unknown = error
  let depth = 0
  while (current && depth < 5) {
    if (current instanceof Error) {
      const code = (current as { code?: string }).code
      parts.push(
        `${current.name}${code ? `(${code})` : ""}: ${current.message}`,
      )
      current = (current as { cause?: unknown }).cause
    } else {
      try {
        parts.push(JSON.stringify(current))
      } catch {
        parts.push("[unserializable cause]")
      }
      break
    }
    depth++
  }
  return parts.join(" <- ")
}

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
