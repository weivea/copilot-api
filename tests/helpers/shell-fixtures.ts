import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..", "..")

/**
 * Build a temp `release/` skeleton mirroring what the packaged tarball
 * looks like, so `crash-handler.sh` and `install.sh` can run against it
 * without touching the real repo.
 */
export async function makeReleaseFixture(): Promise<{
  releaseDir: string
  scriptsDir: string
  cleanup: () => Promise<void>
}> {
  const base = await mkdtemp(path.join(tmpdir(), "copilot-api-fixture-"))
  const releaseDir = path.join(base, "release")
  const scriptsDir = path.join(releaseDir, "scripts")
  await mkdir(scriptsDir, { recursive: true })
  await mkdir(path.join(releaseDir, "bin"), { recursive: true })

  // Copy the real shell scripts so tests run against the actual code.
  for (const name of [
    "crash-handler.sh",
    "install.sh",
    "uninstall.sh",
  ]) {
    const src = path.join(ROOT, "scripts", name)
    const dst = path.join(scriptsDir, name)
    try {
      await cp(src, dst)
    } catch {
      // Some tests may run before all scripts exist; ignore missing.
    }
  }
  // Stub binary so install.sh's existence checks pass.
  await writeFile(path.join(releaseDir, "bin", "copilot-api"), "#!/bin/sh\n", {
    mode: 0o755,
  })
  return {
    releaseDir,
    scriptsDir,
    cleanup: async () => {
      const { rm } = await import("node:fs/promises")
      await rm(base, { recursive: true, force: true })
    },
  }
}
