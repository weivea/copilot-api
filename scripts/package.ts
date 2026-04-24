#!/usr/bin/env bun
/**
 * Build a self-contained release tarball for a given Bun --compile target.
 *
 * Usage:
 *   bun run scripts/package.ts                       # defaults to bun-linux-x64
 *   bun run scripts/package.ts --target=bun-linux-arm64
 *   bun run scripts/package.ts --target=bun-darwin-arm64
 *
 * Target may also be supplied via the BUN_TARGET env var.
 *
 * Output: dist/copilot-api-v<version>-<platform>.tar.gz
 *   where <platform> is derived from the target (e.g. bun-linux-x64 → linux-x64).
 *
 * Layout inside the tarball:
 *   release/
 *     bin/copilot-api[.exe]   (Bun --compile single-file binary)
 *     dist/public/            (frontend static assets)
 *     scripts/                (start.sh / stop.sh / restart.sh)
 *
 * On the target machine:
 *   tar -xzf copilot-api-v<version>-<platform>.tar.gz
 *   cd release && ./scripts/start.sh
 */

import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const DIST = path.join(ROOT, "dist")
const RELEASE = path.join(DIST, "release")

const DEFAULT_TARGET = "bun-linux-x64"

function parseTarget(): string {
  for (const arg of Bun.argv.slice(2)) {
    if (arg.startsWith("--target=")) return arg.slice("--target=".length)
  }
  return process.env.BUN_TARGET || DEFAULT_TARGET
}

function platformSuffix(target: string): string {
  // bun-linux-x64 → linux-x64, bun-darwin-arm64 → darwin-arm64, etc.
  return target.startsWith("bun-") ? target.slice("bun-".length) : target
}

function binFileName(target: string): string {
  return target.includes("windows") ? "copilot-api.exe" : "copilot-api"
}

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(ROOT, "package.json"), "utf8"),
  ) as { version: string }
  return pkg.version
}

async function main() {
  const target = parseTarget()
  const platform = platformSuffix(target)
  const version = await readVersion()
  const tarName = `copilot-api-v${version}-${platform}.tar.gz`
  const tarPath = path.join(DIST, tarName)

  console.log(`[package] cleaning ${RELEASE}`)
  await fs.rm(RELEASE, { recursive: true, force: true })
  await fs.rm(tarPath, { force: true })
  await fs.mkdir(path.join(RELEASE, "bin"), { recursive: true })
  await fs.mkdir(path.join(RELEASE, "dist"), { recursive: true })

  console.log("[package] building frontend")
  await $`bun install`.cwd(path.join(ROOT, "frontend"))
  await $`bun run build`.cwd(path.join(ROOT, "frontend"))

  const publicSrc = path.join(DIST, "public")
  if (!(await fs.stat(publicSrc).catch(() => null))) {
    throw new Error(`frontend build did not produce ${publicSrc}`)
  }

  console.log(`[package] compiling binary (${target})`)
  const binOut = path.join(RELEASE, "bin", binFileName(target))
  await $`bun build ./src/main.ts --compile --target=${target} --minify --outfile ${binOut}`.cwd(
    ROOT,
  )

  console.log("[package] copying frontend assets into release")
  await fs.cp(publicSrc, path.join(RELEASE, "dist", "public"), {
    recursive: true,
  })

  console.log("[package] copying drizzle migrations into release")
  const drizzleSrc = path.join(ROOT, "drizzle")
  if (!(await fs.stat(drizzleSrc).catch(() => null))) {
    throw new Error(
      `drizzle migrations directory not found at ${drizzleSrc}; run 'bun run db:generate' first`,
    )
  }
  await fs.cp(drizzleSrc, path.join(RELEASE, "drizzle"), { recursive: true })

  console.log("[package] copying control scripts into release")
  const scriptsOut = path.join(RELEASE, "scripts")
  await fs.mkdir(scriptsOut, { recursive: true })
  for (const name of ["start.sh", "stop.sh", "restart.sh", "cert.sh"]) {
    const src = path.join(ROOT, "scripts", name)
    const dst = path.join(scriptsOut, name)
    await fs.copyFile(src, dst)
    await fs.chmod(dst, 0o755)
  }

  console.log(`[package] creating ${tarName}`)
  await $`tar -czf ${tarPath} -C ${DIST} release`

  const stat = await fs.stat(tarPath)
  const sizeMb = (stat.size / 1024 / 1024).toFixed(1)
  console.log(`[package] done: ${tarPath} (${sizeMb} MB)`)
}

await main()
