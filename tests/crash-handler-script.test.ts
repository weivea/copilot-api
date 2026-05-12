import { $ } from "bun"
import { describe, test, expect, afterEach } from "bun:test"
import { readdir, utimes } from "node:fs/promises"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  const fn = cleanup
  cleanup = null
  if (fn !== null) await fn()
})

// Canonical seed filename used by the rotation test. Index `i` maps to a unique
// timestamp in 2020-01-0X with mtime staggered minute-by-minute, so i=0 is the
// oldest and i=59 is the newest seed.
const seedName = (i: number) =>
  `2020010${(i % 10) + 1}T00${String(i).padStart(2, "0")}00Z.txt`

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

  test("rotation keeps newest 50 reports", async () => {
    const fx = await makeReleaseFixture()
    const localCleanup = fx.cleanup
    cleanup = localCleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "crash-handler.sh")}`.quiet()

    const crashDir = path.join(fx.releaseDir, "crashes")
    await $`mkdir -p ${crashDir}`.quiet()

    // Pre-seed 60 fake reports with monotonically increasing mtimes by
    // touching each one with a distinct date in 2020-01-01 .. 2020-03-01 range.
    for (let i = 0; i < 60; i++) {
      const fp = path.join(crashDir, seedName(i))
      await Bun.write(fp, `seed ${i}`)
      // Stagger mtime so `ls -t` ordering is deterministic.
      const epoch = 1577836800 + i * 60 // 2020-01-01T00:00:00Z + i minutes
      await utimes(fp, epoch, epoch)
    }

    const proc = await $`${path.join(fx.scriptsDir, "crash-handler.sh")}`
      .env({
        ...process.env,
        SERVICE_RESULT: "signal",
        EXIT_STATUS: "9",
        SERVICE_NAME: "copilot-api",
      })
      .quiet()
      .nothrow()
    expect(proc.exitCode).toBe(0)

    const entries = await readdir(crashDir)
    // Started with 60 seeded files. The handler wrote 1 new file (61 total),
    // then `tail -n +51` removed the 11 oldest (60 + 1 - 50 = 11), leaving 50.
    expect(entries.length).toBe(50)

    // The handler's own freshly-written report (mtime = "now") must survive.
    // It matches the canonical filename pattern with a 2026-or-later year.
    const written = entries.filter(
      (e) => /^\d{8}T\d{6}Z\.txt$/.test(e) && Number(e.slice(0, 4)) >= 2026,
    )
    expect(written.length).toBe(1)

    // The 11 OLDEST seeded files (i=0..10) must have been rotated out.
    for (let i = 0; i < 11; i++) {
      expect(entries).not.toContain(seedName(i))
    }
    // The 49 NEWEST seeded files (i=11..59) must remain.
    for (let i = 11; i < 60; i++) {
      expect(entries).toContain(seedName(i))
    }
  })
})
