import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { readCertificateInfo } from "../src/lib/certificate"
import {
  cleanupFixture,
  makeSelfSignedCert,
  type FixtureCert,
} from "./helpers/cert-fixture"

let tmpHome: string
let configPath: string
let fixture: FixtureCert | null = null

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cpk-home-"))
  configPath = path.join(tmpHome, "copilot-api.config.json")
})

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true })
  if (fixture) {
    cleanupFixture(fixture)
    fixture = null
  }
})

async function writeConfig(obj: unknown): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(obj))
}

describe("readCertificateInfo", () => {
  test("returns not_configured when config has no tls", async () => {
    await writeConfig({})
    const info = await readCertificateInfo({ configPath })
    expect(info.configured).toBe(false)
    if (!info.configured) {
      expect(info.reason).toBe("not_configured")
      expect(info.hint).toContain("./scripts/cert.sh obtain")
    }
  })

  test("returns error branch when cert file missing", async () => {
    const missing = path.join(tmpHome, "nope.pem")
    await writeConfig({
      tls: { cert: missing, key: path.join(tmpHome, "k.pem") },
    })
    const info = await readCertificateInfo({ configPath })
    expect(info.configured).toBe(true)
    if (info.configured && "error" in info) {
      expect(info.error).toContain("ENOENT")
      expect(info.certPath).toBe(missing)
    } else {
      throw new Error("expected error branch")
    }
  })

  test("parses a valid PEM and computes daysRemaining", async () => {
    fixture = makeSelfSignedCert("plan.test", 30)
    await writeConfig({
      domain: "plan.test",
      tls: { cert: fixture.certPath, key: fixture.keyPath },
    })
    const info = await readCertificateInfo({ configPath })
    expect(info.configured).toBe(true)
    if (info.configured && "subject" in info) {
      expect(info.subject).toContain("plan.test")
      expect(info.issuer).toContain("plan.test") // self-signed
      expect(info.domain).toBe("plan.test")
      expect(info.expired).toBe(false)
      expect(info.daysRemaining).toBeGreaterThan(28)
      expect(info.daysRemaining).toBeLessThanOrEqual(30)
      expect(new Date(info.validTo).getTime()).toBeGreaterThan(Date.now())
    } else {
      throw new Error("expected success branch")
    }
  })

  test("returns domain: null when tls is set but domain is not", async () => {
    fixture = makeSelfSignedCert("nodomain.test", 10)
    await writeConfig({
      tls: { cert: fixture.certPath, key: fixture.keyPath },
    })
    const info = await readCertificateInfo({ configPath })
    expect(info.configured).toBe(true)
    if (info.configured && "subject" in info) {
      expect(info.domain).toBeNull()
    } else {
      throw new Error("expected success branch")
    }
  })

  test("flags expired cert", async () => {
    fixture = makeSelfSignedCert("old.test", 1)
    await writeConfig({
      tls: { cert: fixture.certPath, key: fixture.keyPath },
    })
    const realNow = Date.now()
    const info = await readCertificateInfo({
      configPath,
      now: () => realNow + 5 * 86_400_000,
    })
    if (info.configured && "expired" in info) {
      expect(info.expired).toBe(true)
      expect(info.daysRemaining).toBeLessThan(0)
    } else {
      throw new Error("expected success branch with expired=true")
    }
  })
})
