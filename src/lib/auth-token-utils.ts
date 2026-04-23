import crypto from "node:crypto"

export function generateToken(): string {
  return `cpk-${crypto.randomBytes(32).toString("hex")}`
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

export function prefixOf(token: string): string {
  // Display form: first 8 chars (incl. "cpk-") ... last 4 chars
  if (token.length <= 12) return token
  return `${token.slice(0, 8)}...${token.slice(-4)}`
}
