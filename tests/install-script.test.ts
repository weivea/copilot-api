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
})
