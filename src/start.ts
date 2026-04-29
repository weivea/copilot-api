#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"

import { initDb } from "./db/client"
import { expireOldSessions } from "./db/queries/sessions"
import { setupAuthToken } from "./lib/auth-token"
import { loadConfig, resolveTls } from "./lib/config"
import { ensurePaths, PATHS } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { bootstrapCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
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
  noAuth: boolean
  proxyEnv: boolean
  tlsCert?: string
  tlsKey?: string
  httpRedirectPort?: number
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
    await setupGitHubToken({ optional: true })
  }

  if (state.githubToken) {
    await bootstrapCopilotToken()
    await cacheModels()
  } else {
    consola.warn(
      "Copilot endpoints disabled until GitHub login completes via dashboard",
    )
  }
  await setupAuthToken()

  setInterval(
    () => {
      void expireOldSessions().catch(() => {})
    },
    60 * 60 * 1000,
  )

  if (state.models) {
    consola.info(
      `Available models: \n${state.models.data.map((model) => `- ${model.id}`).join("\n")}`,
    )
  }

  const config = await loadConfig()
  const tls = resolveTls(config, options.tlsCert, options.tlsKey)

  const protocol = tls ? "https" : "http"
  const host = config.domain ?? "localhost"
  const serverUrl = `${protocol}://${host}:${options.port}`

  if (tls) {
    consola.info(`TLS enabled — cert: ${tls.cert}, key: ${tls.key}`)
  }

  if (options.claudeCode) {
    if (!state.models) {
      consola.warn(
        "Skipping --claude-code setup: GitHub login not completed. Sign in via dashboard, then rerun with --claude-code.",
      )
    } else {
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
  }

  if (state.dashboardEnabled) {
    const lines =
      state.authEnabled ?
        [
          "📊 Dashboard ready",
          `  URL:   ${serverUrl}/`,
          `  Token: see the "Super admin token" line above, or run \`bun run show-token\``,
          "  Open the URL, then paste the token into the login form.",
        ]
      : ["📊 Dashboard ready", `  URL:   ${serverUrl}/`, "  Auth: disabled"]
    if (!state.githubToken) {
      lines.push("  GitHub: not connected — sign in at /github-auth")
    }
    consola.box(lines.join("\n"))
  }

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    ...(tls && { tls }),
    // Raise Bun's per-request idle timeout from the 10s default. Streamed
    // /v1/messages requests can stay silent for >10s while the upstream
    // model is "thinking", which would otherwise trip Bun.serve into
    // closing the socket and surfacing as AbortError on our end.
    bun: { idleTimeout: 255 },
  })

  if (tls && options.httpRedirectPort !== undefined) {
    const httpsPort = options.port
    const redirectPort = options.httpRedirectPort
    serve({
      port: redirectPort,
      fetch: (req: Request) => {
        const url = new URL(req.url)
        url.protocol = "https:"
        // Strip the redirect listener port; preserve the configured HTTPS port
        // (omit when it's the default 443 so the URL stays clean).
        url.port = httpsPort === 443 ? "" : String(httpsPort)
        // If a domain was configured, force the canonical hostname so direct
        // IP hits also land on the cert's CN.
        if (config.domain) url.hostname = config.domain
        return new Response(null, {
          status: 301,
          headers: { Location: url.toString() },
        })
      },
    })
    consola.info(
      `HTTP→HTTPS redirect listening on :${redirectPort} → :${httpsPort}`,
    )
  }
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
    "http-redirect-port": {
      type: "string",
      description:
        "When TLS is enabled, also listen on this port and 301-redirect to HTTPS (e.g. 80). Disabled by default.",
    },
    "db-path": {
      type: "string",
      description:
        "Path to SQLite DB file (default ~/.local/share/copilot-api/copilot-api.db)",
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
      noAuth: !args.auth,
      proxyEnv: args["proxy-env"],
      tlsCert: args["tls-cert"],
      tlsKey: args["tls-key"],
      httpRedirectPort:
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        args["http-redirect-port"] === undefined ?
          undefined
        : Number.parseInt(args["http-redirect-port"], 10),
      dbPath: args["db-path"],
      logRetentionDays: Number.parseInt(args["log-retention-days"], 10) || 90,
      dashboard: args.dashboard,
    })
  },
})
