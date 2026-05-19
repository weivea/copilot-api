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

  test("02:00 at exactly 02:00:00 returns 86400 (already passed → tomorrow)", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:00", "02:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("86400")
  })

  test("02:00 at 01:59:30 returns 30", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:00", "01:59:30")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("30")
  })

  test("02:00 at 23:59:00 returns 7260", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:00", "23:59:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("7260")
  })

  test("00:00 at 12:00:00 returns 43200", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "00:00", "12:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("43200")
  })

  test("08:00 (leading zero) does not trigger octal interpretation", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "08:00", "07:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("3600")
  })

  test("25:00 fails validation with exit 2", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "25:00", "12:00:00")
    expect(res.exitCode).toBe(2)
    expect(res.stderr).toContain("invalid RESTART_TIME")
  })

  test("02:99 fails validation with exit 2", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:99", "12:00:00")
    expect(res.exitCode).toBe(2)
    expect(res.stderr).toContain("invalid RESTART_TIME")
  })

  test("abc fails validation with exit 2", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "abc", "12:00:00")
    expect(res.exitCode).toBe(2)
    expect(res.stderr).toContain("invalid RESTART_TIME")
  })
})
