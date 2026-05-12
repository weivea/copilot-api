import { $ } from "bun"
import { describe, test, expect, afterEach } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  const fn = cleanup
  cleanup = null
  if (fn !== null) await fn()
})

describe("crash-handler.sh", () => {
  test("exits 0 and writes nothing when SERVICE_RESULT=success", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "crash-handler.sh")}`.quiet()

    const proc = await $`${path.join(fx.scriptsDir, "crash-handler.sh")}`
      .env({
        ...process.env,
        SERVICE_RESULT: "success",
        EXIT_CODE: "exited",
        EXIT_STATUS: "0",
        MAINPID: "12345",
        SERVICE_NAME: "copilot-api",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)

    // crashes/ should not exist or should be empty.
    let entries: Array<string> = []
    try {
      entries = await readdir(path.join(fx.releaseDir, "crashes"))
    } catch {
      /* dir absent is fine */
    }
    expect(entries).toEqual([])
  })

  test("writes report file when SERVICE_RESULT=signal (kill -9)", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "crash-handler.sh")}`.quiet()

    // Pre-seed the application log so the handler has something to tail.
    await Bun.write(
      path.join(fx.releaseDir, "copilot-api.log"),
      "line1\nline2\nfatal: out of memory\n",
    )

    const proc = await $`${path.join(fx.scriptsDir, "crash-handler.sh")}`
      .env({
        ...process.env,
        SERVICE_RESULT: "signal",
        EXIT_CODE: "killed",
        EXIT_STATUS: "9",
        MAINPID: "98765",
        SERVICE_NAME: "copilot-api",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)

    const entries = await readdir(path.join(fx.releaseDir, "crashes"))
    expect(entries.length).toBe(1)

    const reportPath = path.join(fx.releaseDir, "crashes", entries[0])
    const report = await Bun.file(reportPath).text()
    expect(report).toContain("=== Copilot API crash report ===")
    expect(report).toContain("service_result: signal")
    expect(report).toContain("exit_status:    9")
    expect(report).toContain("main_pid:       98765")
    expect(report).toContain("=== Last 200 lines from copilot-api.log ===")
    expect(report).toContain("fatal: out of memory")
    // The journalctl section is best-effort (the binary may not exist on dev
    // machines), so we only assert the section header.
    expect(report).toContain("=== Last 200 lines from journald ===")
    expect(report).toContain("=== System snapshot ===")

    // Filename should be a UTC timestamp like 20260512T034512Z.txt
    expect(entries[0]).toMatch(/^\d{8}T\d{6}Z\.txt$/)
  })
})
