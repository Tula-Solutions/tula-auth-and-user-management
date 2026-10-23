import type { ErrorCode } from '@tula-tech/contract'

/**
 * Password hashes made by another system, accepted by a user import (ADR 0066).
 *
 * Only formats `Bun.password.verify` reads are here. A hash is parsed before it is stored, so
 * that one which cannot be verified, or which is so cheap or so costly that storing it would
 * be a mistake, is refused at import and not discovered at somebody's first sign-in.
 */

/** The `algorithm` names an import row may carry today. TULA-118 adds more, additively. */
export const IMPORT_ALGORITHMS = ['bcrypt', 'argon2id', 'argon2i'] as const

/** An algorithm name {@link IMPORT_ALGORITHMS} lists. */
export type ImportAlgorithm = (typeof IMPORT_ALGORITHMS)[number]

/**
 * The cost floors and ceilings of an imported hash (ADR 0066).
 *
 * Floors are OWASP's minimums for each algorithm: bcrypt work factor 10, argon2 19 MiB of
 * memory with 2 passes. Ceilings exist because the cost is the stored hash's, not ours: a
 * hash asking for 4 GiB would turn every sign-in of that account into a denial of service.
 */
export const HASH_LIMITS = {
  bcrypt: { minCost: 10, maxCost: 14 },
  argon2: {
    minMemoryKiB: 19_456,
    maxMemoryKiB: 262_144,
    minTime: 2,
    maxTime: 10,
    minParallelism: 1,
    maxParallelism: 8,
    minSaltBytes: 8,
    minHashBytes: 16,
  },
} as const

/** What parsing an imported hash decided. */
export type ParsedHash =
  | { ok: true; algorithm: ImportAlgorithm }
  | { ok: false; code: Extract<ErrorCode, `import.${string}`> }

const BCRYPT = /^\$(2[aby])\$(\d{2})\$([./A-Za-z0-9]{53})$/
const ARGON2 =
  /^\$(argon2id|argon2i)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

/** Bytes a base64 string without padding decodes to. */
function base64Bytes(text: string): number {
  return Math.floor((text.length * 3) / 4)
}

/**
 * Which algorithm a stored hash is, from its prefix alone.
 *
 * @param stored - A stored password hash.
 * @returns The algorithm, or `null` for a format this server does not know.
 */
export function detect(stored: string): ImportAlgorithm | null {
  if (stored.startsWith('$argon2id$')) {
    return 'argon2id'
  }
  if (stored.startsWith('$argon2i$')) {
    return 'argon2i'
  }
  return /^\$2[aby]\$/.test(stored) ? 'bcrypt' : null
}

/**
 * Parse an encoded hash that came with an import row and judge its parameters.
 *
 * @param algorithm - The algorithm the row declared.
 * @param encoded - The hash as the other system stored it.
 * @returns The algorithm when the hash is well formed and inside the limits, otherwise the
 *   `import.*` code that says why. A declared algorithm that is not the hash's own is
 *   `import.hash_malformed`: believing the declaration would verify with the wrong rules.
 */
export function parse(algorithm: string, encoded: string): ParsedHash {
  if (!(IMPORT_ALGORITHMS as readonly string[]).includes(algorithm)) {
    return { ok: false, code: 'import.unsupported_algorithm' }
  }
  if (algorithm === 'bcrypt') {
    const match = BCRYPT.exec(encoded)
    if (!match) {
      return { ok: false, code: 'import.hash_malformed' }
    }
    const cost = Number(match[2])
    if (cost < HASH_LIMITS.bcrypt.minCost) {
      return { ok: false, code: 'import.hash_parameters_too_weak' }
    }
    return cost > HASH_LIMITS.bcrypt.maxCost
      ? { ok: false, code: 'import.hash_parameters_too_costly' }
      : { ok: true, algorithm: 'bcrypt' }
  }
  const match = ARGON2.exec(encoded)
  if (!match || match[1] !== algorithm || match[2] !== '19') {
    return { ok: false, code: 'import.hash_malformed' }
  }
  const [memory, time, parallelism] = [Number(match[3]), Number(match[4]), Number(match[5])]
  const limits = HASH_LIMITS.argon2
  if (
    base64Bytes(match[6] ?? '') < limits.minSaltBytes ||
    base64Bytes(match[7] ?? '') < limits.minHashBytes ||
    parallelism < limits.minParallelism
  ) {
    return { ok: false, code: 'import.hash_malformed' }
  }
  // Argon2 needs at least 8 KiB per lane; a smaller `m` is not a hash any library made.
  if (memory < 8 * parallelism) {
    return { ok: false, code: 'import.hash_malformed' }
  }
  if (memory < limits.minMemoryKiB || time < limits.minTime) {
    return { ok: false, code: 'import.hash_parameters_too_weak' }
  }
  if (
    memory > limits.maxMemoryKiB ||
    time > limits.maxTime ||
    parallelism > limits.maxParallelism
  ) {
    return { ok: false, code: 'import.hash_parameters_too_costly' }
  }
  return { ok: true, algorithm: algorithm as ImportAlgorithm }
}
