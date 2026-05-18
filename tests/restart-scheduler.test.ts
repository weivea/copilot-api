import { $ } from "bun"
import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  const fn = cleanup
  cleanup = null
  if (fn !== null) await fn()
})

/**
 * Run a tiny bash snippet that sources restart-scheduler.sh and invokes
 * `compute_delta_seconds`. The script must support being sourced without
 * running its main loop.
 */
async function runComputeDelta(
  scriptsDir: string,
  hhmm: string,
  nowHms: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const scriptPath = path.join(scriptsDir, "restart-scheduler.sh")
  const proc = await $`bash -c ${"source " + scriptPath + " && compute_delta_seconds " + JSON.stringify(hhmm) + " " + JSON.stringify(nowHms)}`
    .quiet()
    .nothrow()
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  }
}

describe("compute_delta_seconds", () => {
  test("02:00 at 01:00:00 returns 3600", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    const res = await runComputeDelta(fx.scriptsDir, "02:00", "01:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("3600")
  })
})
