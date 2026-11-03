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

/** SQLSTATEs of a value the database refuses outright: `\u0000` or bad text in `text`/`jsonb`. */
const DATA_REFUSALS = new Set(['22P05', '22P02', '22021', '22P04'])

/** The one check violation (23514) that is a refusal of a row's data: the import's metadata bound. */
const DATA_CHECKS = new Set(['users_metadata_bounds'])

/** What the database refused: the SQLSTATE and, for a check, the constraint's name. */
export interface DataRefusal {
  code: string
  constraint: string | undefined
}

/**
 * Whether an error is the database refusing the data of a statement (not a conflict), and which.
 *
 * A check violation (23514) counts only when it is a named constraint in {@link DATA_CHECKS};
 * any other check violation is a bug or a different rule and stays a raw error. Nothing of the
 * statement's values is read.
 *
 * @param error - The caught error.
 * @returns The SQLSTATE and constraint found anywhere in the cause chain, or `null`.
 */
export function dataRefusal(error: unknown): DataRefusal | null {
  for (let current = error; current instanceof Object; current = (current as Error).cause) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown }
    if (typeof code !== 'string') {
      continue
    }
    const name = typeof constraint === 'string' ? constraint : undefined
    if (DATA_REFUSALS.has(code) || (code === '23514' && name && DATA_CHECKS.has(name))) {
      return { code, constraint: name }
    }
  }
  return null
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

/**
 * Whether an error is a Postgres check violation, raw (pg / PGlite) or wrapped by Drizzle in
 * `cause`: a row broke a rule of its table.
 *
 * @param error - The caught error.
 * @returns `true` for SQLSTATE 23514 anywhere in the cause chain.
 */
export function isCheckViolation(error: unknown): boolean {
  for (let current = error; current instanceof Object; current = (current as Error).cause) {
    if ((current as { code?: unknown }).code === '23514') {
      return true
    }
  }
  return false
}
