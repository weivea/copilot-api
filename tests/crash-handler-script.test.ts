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
})
