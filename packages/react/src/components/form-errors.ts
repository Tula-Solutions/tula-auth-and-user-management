import type { TulaError } from '@tula/core'
import { formatText, type TulaLocalization } from '../localization'

/** A failed action's messages, sorted by where a form shows them. */
export interface PlacedErrors {
  /** Shown above the form: what is not about one field (rate limits, network, the server). */
  form: string | null
  /** Shown under a field, by the form's own field name. */
  fields: Record<string, string[]>
}

/**
 * Says which of a form's fields a problem belongs to.
 *
 * @param code - The problem's error code.
 * @param field - The request field the server named, when it named one.
 * @returns The form's field name, or `null` for "not about a field of this form".
 */
export type FieldResolver = (code: string, field: string | null) => string | null

/**
 * The usual mapping: the server's field name when the form has that field, otherwise by the
 * code's area (`email.*`, `password.*`, `verification.*`).
 *
 * @param fields - The form's field names.
 * @param credentialsField - Where `auth.invalid_credentials` goes: the server never says which
 *   of the email and the password was wrong, so a form shows it at the last thing typed.
 * @returns The resolver.
 */
export function fieldResolver(fields: readonly string[], credentialsField?: string): FieldResolver {
  const byArea: Record<string, string> = {
    email: 'email',
    password: 'password',
    verification: 'code',
  }
  return (code, field) => {
    if (field !== null && fields.includes(field)) {
      return field
    }
    if (code === 'auth.invalid_credentials') {
      return credentialsField ?? null
    }
    const area = code.split('.')[0] ?? ''
    const target = Object.hasOwn(byArea, area) ? byArea[area] : undefined
    return target !== undefined && fields.includes(target) ? target : null
  }
}

/**
 * Sort an error's messages into "under this field" and "above the form".
 *
 * A password the policy rejects carries one field error per unmet rule; each is listed under
 * the password field. An error with no field errors is placed by its own code. Every message
 * is text from the client's locale table; nothing here is rendered as HTML.
 *
 * @param error - The failed action's error, or `null`.
 * @param resolve - Which field a problem belongs to.
 * @returns The messages by place.
 */
export function placeErrors(error: TulaError | null, resolve: FieldResolver): PlacedErrors {
  const placed: PlacedErrors = { form: null, fields: {} }
  if (!error) {
    return placed
  }
  const add = (field: string, message: string) => {
    const list = placed.fields[field] ?? []
    if (!list.includes(message)) {
      list.push(message)
    }
    placed.fields[field] = list
  }
  let unplaced = false
  for (const problem of error.errors) {
    const field = resolve(problem.code, problem.field)
    if (field === null) {
      unplaced = true
    } else {
      add(field, problem.message)
    }
  }
  if (error.errors.length === 0) {
    const field = resolve(error.code, null)
    if (field === null) {
      placed.form = error.message
    } else {
      add(field, error.message)
    }
  } else if (unplaced) {
    placed.form = error.message
  }
  return placed
}

/**
 * The sentence that follows a wrong code: how many guesses are left before the code is
 * retired, taken from the error's `attemptsRemaining` param.
 *
 * @param error - The error.
 * @param t - The strings.
 * @returns The sentence, or `null` when the error does not say.
 */
export function attemptsLeft(error: TulaError | null, t: TulaLocalization): string | null {
  const remaining =
    error && Object.hasOwn(error.params, 'attemptsRemaining')
      ? error.params.attemptsRemaining
      : undefined
  if (typeof remaining !== 'number' || remaining < 0) {
    return null
  }
  return remaining === 1
    ? t.verification.attemptsRemainingOne
    : formatText(t.verification.attemptsRemaining, { count: remaining })
}

/**
 * A duration for a countdown, e.g. `42s` or `4m 12s`.
 *
 * @param totalSeconds - Whole seconds.
 * @param t - The strings.
 * @returns The text.
 */
export function formatDuration(totalSeconds: number, t: TulaLocalization): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0
    ? formatText(t.common.minutesSeconds, { minutes, seconds })
    : formatText(t.common.seconds, { seconds })
}
