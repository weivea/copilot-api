import consola from "consola"
import { randomUUID } from "node:crypto"

import { state } from "~/lib/state"
import {
  bootstrapCopilotToken,
  stopCopilotTokenRefresh,
  writeGithubToken,
} from "~/lib/token"
import { cacheModels } from "~/lib/utils"

import { getDeviceCode } from "./get-device-code"
import { getGitHubUser } from "./get-user"
import { requestAccessToken } from "./request-access-token"

export type DeviceFlowStatus =
  | "pending"
  | "success"
  | "error"
  | "expired"
  | "cancelled"

export interface DeviceFlow {
  id: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: number
  intervalSec: number
  status: DeviceFlowStatus
  error?: string
  login?: string
  createdAt: number
  startedBy: number | "super"
}

const flows = new Map<string, DeviceFlow>()
let activeFlowId: string | undefined
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

const CLEANUP_DELAY_MS = 5 * 60 * 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function scheduleCleanup(id: string): void {
  const existing = cleanupTimers.get(id)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    flows.delete(id)
    cleanupTimers.delete(id)
  }, CLEANUP_DELAY_MS)
  ;(timer as { unref?: () => void }).unref?.()
  cleanupTimers.set(id, timer)
}

function finalize(id: string): void {
  if (activeFlowId === id) activeFlowId = undefined
  scheduleCleanup(id)
}

export function getFlow(id: string): DeviceFlow | undefined {
  return flows.get(id)
}

export function getActiveFlow(): DeviceFlow | undefined {
  if (!activeFlowId) return undefined
  return flows.get(activeFlowId)
}

export function cancelFlow(id: string): void {
  const flow = flows.get(id)
  if (!flow) return
  if (flow.status === "pending") {
    flow.status = "cancelled"
  }
  finalize(id)
}

export async function startDeviceFlow(
  startedBy: number | "super",
): Promise<DeviceFlow> {
  const existing = activeFlowId ? flows.get(activeFlowId) : undefined
  if (existing && existing.status === "pending") {
    return existing
  }

  const deviceCode = await getDeviceCode()
  const id = randomUUID()
  const now = Date.now()
  const flow: DeviceFlow = {
    id,
    userCode: deviceCode.user_code,
    verificationUri: deviceCode.verification_uri,
    verificationUriComplete: deviceCode.verification_uri_complete,
    expiresAt: now + deviceCode.expires_in * 1000,
    intervalSec: deviceCode.interval,
    status: "pending",
    createdAt: now,
    startedBy,
  }
  flows.set(id, flow)
  // eslint-disable-next-line require-atomic-updates -- Single-threaded; `activeFlowId` is only set here after the existence check above.
  activeFlowId = id
  const idForPoll = id
  void runPolling(idForPoll, deviceCode.device_code)
  return flow
}

async function handleAccessToken(
  flow: DeviceFlow,
  accessToken: string,
): Promise<void> {
  try {
    await writeGithubToken(accessToken)
    state.githubToken = accessToken
    const user = await getGitHubUser()
    state.githubLogin = user.login
    flow.login = user.login
    stopCopilotTokenRefresh()
    await bootstrapCopilotToken()
    await cacheModels()
    flow.status = "success"
  } catch (error) {
    consola.error("Device flow: post-token bootstrap failed", error)
    flow.status = "error"
    flow.error = error instanceof Error ? error.message : String(error)
  }
}

type PollOutcome = "continue" | "done"

function handlePollError(flow: DeviceFlow, error: string | undefined): void {
  switch (error) {
    case "expired_token": {
      flow.status = "expired"
      break
    }
    case "access_denied": {
      flow.status = "error"
      flow.error = "User denied access"
      break
    }
    default: {
      flow.status = "error"
      flow.error = error ?? "Unknown error"
      break
    }
  }
}

async function pollOnce(
  flow: DeviceFlow,
  deviceCode: string,
): Promise<PollOutcome> {
  let resp
  try {
    resp = await requestAccessToken(deviceCode)
  } catch (error) {
    consola.error("Device flow: requestAccessToken failed", error)
    flow.status = "error"
    flow.error = error instanceof Error ? error.message : String(error)
    return "done"
  }

  if (resp.access_token) {
    await handleAccessToken(flow, resp.access_token)
    return "done"
  }

  if (resp.error === "authorization_pending") return "continue"
  if (resp.error === "slow_down") {
    flow.intervalSec += 5
    return "continue"
  }
  handlePollError(flow, resp.error_description ?? resp.error)
  return "done"
}

async function runPolling(id: string, deviceCode: string): Promise<void> {
  while (true) {
    const flow = flows.get(id)
    if (!flow || flow.status !== "pending") return

    if (Date.now() > flow.expiresAt) {
      flow.status = "expired"
      finalize(id)
      return
    }

    await sleep(flow.intervalSec * 1000)

    const current = flows.get(id)
    if (!current || current.status !== "pending") return

    const outcome = await pollOnce(current, deviceCode)
    if (outcome === "done") {
      finalize(id)
      return
    }
  }
}

export function __resetDeviceFlowsForTest(): void {
  for (const timer of cleanupTimers.values()) clearTimeout(timer)
  cleanupTimers.clear()
  flows.clear()
  activeFlowId = undefined
}
