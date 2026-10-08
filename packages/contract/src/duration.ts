import { z } from 'zod'

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** Longest duration accepted anywhere in config: 10 years. */
export const MAX_DURATION_MS = 3650 * UNIT_MS.d

// Positive integer (no leading zero, at most 7 digits) + unit. Zero-length TTLs would issue
// already-expired tokens, and unbounded digit strings overflow to Infinity.
const DURATION_PATTERN = /^([1-9]\d{0,6})(s|m|h|d)$/

function parse(duration: string): number | null {
  const match = DURATION_PATTERN.exec(duration)
  if (!match) {
    return null
  }
  const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_MS]
  const ms = Number(amount) * UNIT_MS[unit]
  return ms <= MAX_DURATION_MS ? ms : null
}

/** A positive, human-friendly duration used in config, e.g. `60s`, `15m`, `8h`, `30d` (max 10 years). */
export const DurationSchema = z
  .string()
  .refine((value) => parse(value) !== null, {
    message: 'Use a positive number followed by s, m, h or d, up to 3650d (e.g. "30d")',
  })
  .meta({ ref: 'Duration' })

/** A duration string such as `"30d"`. */
export type Duration = z.infer<typeof DurationSchema>

/**
 * Convert a duration string to milliseconds.
 *
 * @param duration - A value like `60s`, `15m`, `8h` or `30d`.
 * @returns The duration in milliseconds.
 * @throws If `duration` is malformed, zero, or longer than {@link MAX_DURATION_MS}.
 *
 * @example
 * ```ts
 * durationToMs('7d') // 604800000
 * ```
 */
export function durationToMs(duration: string): number {
  const ms = parse(duration)
  if (ms === null) {
    throw new Error(`Invalid duration "${duration}"`)
  }
  return ms
}
