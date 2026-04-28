import { X509Certificate } from "node:crypto"
import fs from "node:fs/promises"

import { loadConfig } from "./config"

export type CertificateInfo =
  | {
      configured: false
      reason: "not_configured"
      hint: string
    }
  | {
      configured: true
      error: string
      certPath: string
    }
  | {
      configured: true
      domain: string | null
      subject: string
      issuer: string
      validFrom: string
      validTo: string
      daysRemaining: number
      expired: boolean
      certPath: string
    }

const NOT_CONFIGURED_HINT =
  "Run ./scripts/cert.sh obtain --domain <your-domain> to obtain a certificate."

export async function readCertificateInfo(): Promise<CertificateInfo> {
  const config = await loadConfig()
  const certPath = config.tls?.cert
  if (!certPath) {
    return {
      configured: false,
      reason: "not_configured",
      hint: NOT_CONFIGURED_HINT,
    }
  }
  try {
    const pem = await fs.readFile(certPath)
    const cert = new X509Certificate(pem)
    const validFrom = new Date(cert.validFrom)
    const validTo = new Date(cert.validTo)
    const now = Date.now()
    const daysRemaining = Math.floor((validTo.getTime() - now) / 86_400_000)
    return {
      configured: true,
      domain: config.domain ?? null,
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysRemaining,
      expired: daysRemaining < 0,
      certPath,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { configured: true, error: message, certPath }
  }
}
