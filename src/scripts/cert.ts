#!/usr/bin/env node

/**
 * Certbot helper script for obtaining and renewing TLS certificates.
 *
 * Usage:
 *   bun run cert:obtain -- --domain example.com
 *   bun run cert:renew
 */

import consola from "consola"
import { execSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

import { CERTS_DIR, deriveCertbotPaths, loadConfig } from "../lib/config"

const LOCAL_CONFIG_NAME = "copilot-api.config.json"

type Action = "obtain" | "renew"

function getAction(): Action {
  const arg = process.argv[2]
  if (arg === "obtain" || arg === "renew") return arg
  consola.error(`Unknown action: ${arg}. Use "obtain" or "renew".`)
  process.exit(1)
}

function getDomainFromArgs(): string | undefined {
  const idx = process.argv.indexOf("--domain")
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
  }
  return undefined
}

function run(command: string): void {
  consola.info(`Running: ${command}`)
  execSync(command, { stdio: "inherit" })
}

function certbotDirFlags(): string {
  const certsDir = path.resolve(process.cwd(), CERTS_DIR)
  return `--config-dir ${certsDir} --work-dir ${certsDir}/work --logs-dir ${certsDir}/logs`
}

function ensureCertbot(): void {
  try {
    execSync("certbot --version", { stdio: "ignore" })
  } catch {
    consola.error("certbot is not installed or not found in PATH.")
    consola.info("")
    consola.info("Install certbot for your platform:")
    consola.info("  Linux (Ubuntu/Debian): sudo apt install certbot")
    consola.info("  Linux (Fedora/RHEL):   sudo dnf install certbot")
    consola.info("  macOS:                 brew install certbot")
    consola.info("  Windows:               pip install certbot")
    consola.info("  All platforms:         pip install certbot")
    consola.info("")
    consola.info("For more details: https://certbot.eff.org/instructions")
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const action = getAction()

  ensureCertbot()

  if (action === "renew") {
    run(`certbot renew ${certbotDirFlags()}`)
    consola.success("Certificate renewal complete")
    return
  }

  // obtain
  const cliDomain = getDomainFromArgs()
  const config = await loadConfig()
  const domain = cliDomain ?? config.domain

  if (!domain) {
    consola.error(
      'No domain specified. Use --domain <domain> or set "domain" in config.json',
    )
    process.exit(1)
  }

  run(`certbot certonly --standalone -d ${domain} ${certbotDirFlags()}`)

  const paths = deriveCertbotPaths(domain)
  const configContent = { domain, tls: paths }
  const configPath = path.resolve(process.cwd(), LOCAL_CONFIG_NAME)

  await fs.writeFile(configPath, JSON.stringify(configContent, null, 2) + "\n")

  consola.success(`Certificate obtained for ${domain}`)
  consola.info(`  cert: ${paths.cert}`)
  consola.info(`  key:  ${paths.key}`)
  consola.success(`Config written to ${configPath}`)
}

await main()
