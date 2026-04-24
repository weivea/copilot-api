import type { Bucket } from "../types"

const DAY = 86_400_000

export function suggestBucket(from: number, to: number): Bucket {
  const span = to - from
  if (span <= 2 * DAY) return "hour"
  if (span <= 60 * DAY) return "day"
  if (span <= 365 * DAY) return "week"
  return "month"
}
