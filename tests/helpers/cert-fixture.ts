import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface FixtureCert {
  dir: string
  certPath: string
  keyPath: string
}

/**
 * Writes a self-signed cert + key into a fresh temp dir using `openssl`.
 * Tests that need a custom validity window pass `daysValid` (negative = expired).
 */
export function makeSelfSignedCert(
  domain = "example.test",
  daysValid = 90,
): FixtureCert {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpk-cert-"))
  const certPath = path.join(dir, "fullchain.pem")
  const keyPath = path.join(dir, "privkey.pem")
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${domain}`,
      "-days",
      String(daysValid),
    ],
    { stdio: "ignore" },
  )
  return { dir, certPath, keyPath }
}

export function cleanupFixture(f: FixtureCert): void {
  fs.rmSync(f.dir, { recursive: true, force: true })
}
