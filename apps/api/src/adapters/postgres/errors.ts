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
