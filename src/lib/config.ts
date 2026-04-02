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

const LOCAL_CONFIG_NAME = "copilot-api.config.json"

export const CERTS_DIR = ".certs"

export function deriveCertbotPaths(domain: string, baseDir?: string) {
  const base = baseDir ?? path.resolve(process.cwd(), CERTS_DIR)
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
 * 2. Project root: ./copilot-api.config.json
 * 3. Global: ~/.local/share/copilot-api/config.json
 */
export async function loadConfig(configPath?: string): Promise<AppConfig> {
  if (configPath) {
    const config = await tryReadConfig(configPath)
    if (config) return config
    consola.warn(`Config file not found at ${configPath}, using defaults`)
    return {}
  }

  const localPath = path.resolve(process.cwd(), LOCAL_CONFIG_NAME)
  const localConfig = await tryReadConfig(localPath)
  if (localConfig) return localConfig

  const globalConfigPath: unknown = PATHS.CONFIG_PATH
  if (typeof globalConfigPath === "string") {
    const globalConfig = await tryReadConfig(globalConfigPath)
    if (globalConfig) return globalConfig
  } else {
    consola.warn("Global config path is not a string, skipping global config")
  }

  consola.debug("No config file found, using defaults")
  return {}
}
