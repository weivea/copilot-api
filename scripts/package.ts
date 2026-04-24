#!/usr/bin/env bun
/**
 * Build a self-contained Linux x64 release tarball.
 *
 * Output: dist/copilot-api-v<version>-linux-x64.tar.gz
 *
 * Layout inside the tarball:
 *   release/
 *     bin/copilot-api        (Bun --compile single-file binary)
 *     dist/public/           (frontend static assets)
 *     scripts/               (start.sh / stop.sh / restart.sh)
 *
 * On the target machine:
 *   tar -xzf copilot-api-v<version>-linux-x64.tar.gz
 *   cd release && ./scripts/start.sh
 */

import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const DIST = path.join(ROOT, "dist")
const RELEASE = path.join(DIST, "release")
const TARGET = "bun-linux-x64"

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(ROOT, "package.json"), "utf8"),
  ) as { version: string }
  return pkg.version
}

async function main() {
  const version = await readVersion()
  const tarName = `copilot-api-v${version}-linux-x64.tar.gz`
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

  console.log(`[package] compiling binary (${TARGET})`)
  const binOut = path.join(RELEASE, "bin", "copilot-api")
  await $`bun build ./src/main.ts --compile --target=${TARGET} --minify --outfile ${binOut}`.cwd(
    ROOT,
  )

  console.log("[package] copying frontend assets into release")
  await fs.cp(publicSrc, path.join(RELEASE, "dist", "public"), {
    recursive: true,
  })

  console.log("[package] copying control scripts into release")
  const scriptsOut = path.join(RELEASE, "scripts")
  await fs.mkdir(scriptsOut, { recursive: true })
  for (const name of ["start.sh", "stop.sh", "restart.sh"]) {
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
