/** Thrown inside a transaction to roll it back when a guarded update matched nothing. */
export class LostRace extends Error {
  // Explicit so Bun's per-file function coverage sees the constructor being called.
  constructor() {
    super('guarded update matched no row')
    this.name = 'LostRace'
  }
}

/**
 * Whether an error is a Postgres unique violation, raw (pg / PGlite) or wrapped by Drizzle in
 * `cause`.
 *
 * @param error - The caught error.
 * @returns `true` for SQLSTATE 23505 anywhere in the cause chain.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Object; current = (current as Error).cause) {
    if ((current as { code?: unknown }).code === '23505') {
      return true
    }
  }
  return false
}

/** SQLSTATEs of a value the database refuses: check violation, bad `json` text, bad bytes/NUL. */
const DATA_REFUSALS = new Set(['23514', '22P05', '22P02', '22021', '22P04'])

/**
 * Whether an error is the database refusing the data of a statement (not a conflict): a check
 * violation, a `\u0000` or an invalid string in `text` or `jsonb`.
 *
 * @param error - The caught error.
 * @returns `true` for one of those SQLSTATEs anywhere in the cause chain.
 */
export function isDataRefusal(error: unknown): boolean {
  for (let current = error; current instanceof Object; current = (current as Error).cause) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && DATA_REFUSALS.has(code)) {
      return true
    }
  }
  return false
}

/**
 * Whether an error is a Postgres foreign-key violation, raw (pg / PGlite) or wrapped by Drizzle
 * in `cause`: the row a new row points at is not there (any more).
 *
 * @param error - The caught error.
 * @returns `true` for SQLSTATE 23503 anywhere in the cause chain.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  for (let current = error; current instanceof Object; current = (current as Error).cause) {
    if ((current as { code?: unknown }).code === '23503') {
      return true
    }
  }
  return false
}
