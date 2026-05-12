import { $ } from "bun"
import { describe, test, expect, afterEach } from "bun:test"
import { mkdir, cp } from "node:fs/promises"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

const ROOT = path.resolve(import.meta.dir, "..")

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  const fn = cleanup
  cleanup = null
  if (fn !== null) await fn()
})

async function seedSystemdTemplate(releaseDir: string) {
  const dst = path.join(releaseDir, "scripts", "systemd")
  await mkdir(dst, { recursive: true })
  await cp(
    path.join(ROOT, "scripts", "systemd", "copilot-api.service.template"),
    path.join(dst, "copilot-api.service.template"),
  )
}

describe("install.sh", () => {
  test("--render-only prints unit with placeholders substituted", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --render-only --user testuser --name copilot-api-test`
        .cwd(fx.releaseDir)
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)
    const out = proc.stdout.toString()

    expect(out).toContain("# release-schema=1")
    expect(out).toContain("User=testuser")
    expect(out).toContain(`WorkingDirectory=${fx.releaseDir}`)
    expect(out).toContain(`EnvironmentFile=${fx.releaseDir}/.env`)
    expect(out).toContain(
      `ExecStart=/bin/sh -c '${fx.releaseDir}/bin/copilot-api start $COPILOT_API_ARGS'`,
    )
    expect(out).toContain(
      `ExecStopPost=${fx.releaseDir}/scripts/crash-handler.sh`,
    )
    expect(out).toContain("SyslogIdentifier=copilot-api-test")
    expect(out).toContain("Environment=SERVICE_NAME=copilot-api-test")
    expect(out).toContain("Restart=on-failure")
    expect(out).toContain("RestartSec=5s")
    expect(out).toContain("StartLimitBurst=0")

    // No unrendered placeholders left.
    expect(out).not.toContain("__USER__")
    expect(out).not.toContain("__RELEASE_DIR__")
    expect(out).not.toContain("__SERVICE_NAME__")
  })

  test("--user defaults to $USER when SUDO_USER is unset", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const env = { ...process.env, USER: "alice" }
    delete (env as Record<string, string | undefined>).SUDO_USER

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --render-only`
        .cwd(fx.releaseDir)
        .env(env)
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("User=alice")
  })

  test("--user prefers SUDO_USER over USER", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --render-only`
        .cwd(fx.releaseDir)
        .env({ ...process.env, USER: "root", SUDO_USER: "deployer" })
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("User=deployer")
  })

  test("--name defaults to copilot-api", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --render-only --user x`
        .cwd(fx.releaseDir)
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)
    const out = proc.stdout.toString()
    expect(out).toContain("SyslogIdentifier=copilot-api")
    expect(out).toContain("Environment=SERVICE_NAME=copilot-api")
  })

  test("unknown flag prints usage and exits 2", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc = await $`${path.join(fx.scriptsDir, "install.sh")} --bogus`
      .cwd(fx.releaseDir)
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(2)
    expect(proc.stderr.toString()).toContain("Unknown option: --bogus")
    expect(proc.stderr.toString()).toContain("Usage: install.sh")
  })
})
