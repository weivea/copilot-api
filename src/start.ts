#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { setupAuthToken } from "./lib/auth-token"
import { loadConfig, resolveTls } from "./lib/config"
import { ensurePaths, PATHS } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { initDb } from "./db/client"
import { expireOldSessions } from "./db/queries/sessions"
import { server } from "./server"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  noAuth: boolean
  proxyEnv: boolean
  tlsCert?: string
  tlsKey?: string
  dbPath?: string
  logRetentionDays: number
  dashboard: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.authEnabled = !options.noAuth

  await ensurePaths()
  state.dbPath = options.dbPath ?? PATHS.DB_PATH
  state.logRetentionDays = options.logRetentionDays
  state.dashboardEnabled = options.dashboard
  initDb(state.dbPath)
  await cacheVSCodeVersion()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()
  await setupAuthToken()

  setInterval(() => {
    void expireOldSessions().catch(() => {})
  }, 60 * 60 * 1000)

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const config = await loadConfig()
  const tls = resolveTls(config, options.tlsCert, options.tlsKey)

  const protocol = tls ? "https" : "http"
  const host = config.domain ?? "localhost"
  const serverUrl = `${protocol}://${host}:${options.port}`

  if (tls) {
    consola.info(`TLS enabled — cert: ${tls.cert}, key: ${tls.key}`)
  }

  if (options.claudeCode) {
    invariant(state.models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: state.superAdminToken ?? "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "claude",
    )

    try {
      clipboard.writeSync(command)
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  if (state.dashboardEnabled) {
    consola.box(
      `📊 Dashboard: ${serverUrl}/?key=${state.superAdminToken ?? "<your-token>"}`,
    )
  }

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    ...(tls && { tls }),
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    auth: {
      type: "boolean",
      default: true,
      description: "Enable auth token verification (pass --no-auth to disable)",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "tls-cert": {
      type: "string",
      description: "Path to TLS certificate file (PEM format)",
    },
    "tls-key": {
      type: "string",
      description: "Path to TLS private key file (PEM format)",
    },
    "db-path": {
      type: "string",
      description: "Path to SQLite DB file (default ~/.local/share/copilot-api/copilot-api.db)",
    },
    "log-retention-days": {
      type: "string",
      default: "90",
      description: "Days to retain request_logs",
    },
    dashboard: {
      type: "boolean",
      default: true,
      description: "Enable admin dashboard + API (--no-dashboard to disable)",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      noAuth: !args.auth,
      proxyEnv: args["proxy-env"],
      tlsCert: args["tls-cert"],
      tlsKey: args["tls-key"],
      dbPath: args["db-path"],
      logRetentionDays: Number.parseInt(args["log-retention-days"], 10) || 90,
      dashboard: args.dashboard,
    })
  },
})
