/** An error reduced to what is safe to write to a log. */
export interface ErrorDescription {
  /** The error's class name, or `DatabaseError` for anything that came from a query. */
  name: string
  /** Absent for database errors, whose messages can quote the values of a query. */
  message?: string
  /** SQLSTATE of a database error, e.g. `23505`. */
  code?: string
  constraint?: string
  table?: string
  column?: string
  stack?: string
}

// Five characters, at least one of them a digit: every SQLSTATE Postgres emits has one, and it
// keeps Node's all-letter system codes (`EPIPE`, `EPERM`) from being taken for database errors.
const SQLSTATE = /^(?=.*[0-9])[0-9A-Z]{5}$/

/** Names of database objects, as Postgres reports them. Never values. */
const OBJECT_FIELDS = ['constraint', 'table', 'column'] as const

function field(error: object, name: string): string | undefined {
  const value = (error as Record<string, unknown>)[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A Drizzle query error: its message is the SQL followed by every bound parameter. */
function isQueryError(error: object): boolean {
  return 'query' in error && 'params' in error
}

/** What the Postgres driver (pg or PGlite) throws: it carries an SQLSTATE. */
function sqlState(error: object): string | undefined {
  const code = field(error, 'code')
  return code && SQLSTATE.test(code) ? code : undefined
}

/** Every error in a cause chain, outermost first, stopping if the chain loops. */
function chain(error: unknown): Error[] {
  const seen: Error[] = []
  for (let current = error; current instanceof Error && !seen.includes(current); ) {
    seen.push(current)
    current = current.cause
  }
  return seen
}

/** The frames of a stack without its first line, which repeats the message. */
function framesOnly(stack: string | undefined): string | undefined {
  const frames = stack?.split('\n').filter((line) => line.trimStart().startsWith('at '))
  return frames && frames.length > 0 ? frames.join('\n') : undefined
}

/**
 * Describe an error for a log line without the data it may carry.
 *
 * A failed database query is the dangerous case. Drizzle's error message is the SQL plus every
 * bound parameter (emails, password hashes, token hashes), and the driver's own message can
 * quote an input value. The logger redacts by field name and cannot see inside a message, so
 * for anything that came from the database only the SQLSTATE, the names of the objects involved
 * and the stack frames are kept.
 *
 * @param error - Whatever was thrown.
 * @returns Name, and either the message and stack (ordinary errors) or the SQLSTATE and object
 *   names (database errors).
 *
 * @example
 * ```ts
 * logger.error('request failed', { err: describeError(error) })
 * ```
 */
export function describeError(error: unknown): ErrorDescription {
  const errors = chain(error)
  const [outer] = errors
  if (!outer) {
    return { name: 'NonError', message: String(error) }
  }
  const driver = errors.find((candidate) => sqlState(candidate) !== undefined)
  if (!driver && !errors.some(isQueryError)) {
    return { name: outer.name, message: outer.message, stack: outer.stack }
  }
  const description: ErrorDescription = { name: 'DatabaseError' }
  if (driver) {
    description.code = sqlState(driver)
    for (const name of OBJECT_FIELDS) {
      const value = field(driver, name)
      if (value) {
        description[name] = value
      }
    }
  }
  description.stack = framesOnly(outer.stack)
  return description
}

/**
 * One line saying why something failed, for a `reason` field.
 *
 * @param error - Whatever was thrown.
 * @returns `database error <SQLSTATE>` for a database error, otherwise the error's message.
 */
export function errorReason(error: unknown): string {
  const { name, code, message } = describeError(error)
  if (name === 'DatabaseError') {
    return code ? `database error ${code}` : 'database error'
  }
  return message ?? name
}
