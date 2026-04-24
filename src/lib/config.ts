import consola from "consola"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import { PATHS } from "./paths"

const tlsSchema = z.object({
  cert: z.string(),
  key: z.string(),
})

const configSchema = z.object({
  domain: z.string().optional(),
  tls: tlsSchema.optional(),
})

export type AppConfig = z.infer<typeof configSchema>

const PROJECT_CONFIG_FILENAME = "copilot-api.config.json"

export function deriveCertbotPaths(domain: string, baseDir?: string) {
  const base = baseDir ?? PATHS.CERTS_DIR
  return {
    cert: path.join(base, "live", domain, "fullchain.pem"),
    key: path.join(base, "live", domain, "privkey.pem"),
  }
}

export interface ResolvedTls {
  cert: string
  key: string
}

/**
 * Resolves TLS configuration from CLI args, config file, or certbot defaults.
 * Priority: CLI args > config file tls > auto-derived from domain.
 */
export function resolveTls(
  config: AppConfig,
  cliCert?: string,
  cliKey?: string,
): ResolvedTls | undefined {
  if (cliCert && cliKey) {
    return { cert: cliCert, key: cliKey }
  }

  if (config.tls) {
    return config.tls
  }

  if (config.domain) {
    return deriveCertbotPaths(config.domain)
  }

  return undefined
}

async function tryReadConfig(filePath: string): Promise<AppConfig | null> {
  try {
    const raw = await fs.readFile(filePath)
    const json: unknown = JSON.parse(raw.toString("utf8"))
    const config = configSchema.parse(json)
    consola.debug(`Loaded config from ${filePath}`)
    return config
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }
    consola.warn(`Failed to load config from ${filePath}:`, error)
    return null
  }
}

/**
 * Loads config with the following priority:
 * 1. Explicit path (--config CLI arg)
 * 2. Global: ~/.local/share/copilot-api/copilot-api.config.json
 * 3. Project root: ./copilot-api.config.json
 */
export async function loadConfig(configPath?: string): Promise<AppConfig> {
  if (configPath) {
    const config = await tryReadConfig(configPath)
    if (config) return config
    consola.warn(`Config file not found at ${configPath}, using defaults`)
    return {}
  }

  const globalConfig = await tryReadConfig(PATHS.CONFIG_PATH)
  if (globalConfig) return globalConfig

  const projectPath = path.resolve(process.cwd(), PROJECT_CONFIG_FILENAME)
  const projectConfig = await tryReadConfig(projectPath)
  if (projectConfig) return projectConfig

  consola.debug("No config file found, using defaults")
  return {}
}
