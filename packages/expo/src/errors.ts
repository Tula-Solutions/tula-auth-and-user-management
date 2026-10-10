import { EN_MESSAGES, isTulaError, TulaError } from '@tula/core'

/**
 * Make sure a caught value is a `TulaError`, so that hooks have one error type in their state.
 *
 * Everything `@tula/core` throws already is one. Anything else is a bug somewhere (a
 * `TypeError`, say); it becomes an `internal` error with the generic message, and the original
 * is kept as `cause` for the developer. Its own message is not shown: it was not written for
 * users.
 *
 * @param caught - The caught value.
 * @returns A `TulaError`.
 */
export function toTulaError(caught: unknown): TulaError {
  return isTulaError(caught)
    ? caught
    : new TulaError({ code: 'internal', message: EN_MESSAGES.internal, cause: caught })
}
