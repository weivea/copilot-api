import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  githubLogin?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Outbound auth configuration
  authEnabled: boolean
  // The file-resident super admin token (plaintext, kept in memory for compare)
  superAdminToken?: string
  superAdminTokenHash?: string
  superAdminTokenId?: number

  // Dashboard / DB configuration
  dashboardEnabled: boolean
  dbPath?: string
  logRetentionDays: number
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  authEnabled: true,
  dashboardEnabled: true,
  logRetentionDays: 90,
}
