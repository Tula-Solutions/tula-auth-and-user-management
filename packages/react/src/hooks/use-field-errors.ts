import type { TulaError } from '@tula-tech/core'
import { useMemo } from 'react'
import { fieldResolver, type PlacedErrors, placeErrors } from '../components/form-errors'

/**
 * Sort a failed action's messages into "under this field" and "above the form".
 *
 * A message belongs to the field the server named (`error.errors[].field`) when the form has
 * that field, and otherwise to the field its code's area names (`email.*`, `password.*`,
 * `verification.*` go to `email`, `password`, `code`). `auth.invalid_credentials` goes to
 * `credentialsField`, because the server never says which of the two was wrong. What belongs to
 * no field is the form's. Every message is text from the client's locale table: render it as
 * text, never as HTML.
 *
 * @param error - The failed action's error (a flow hook's `error`), or `null`.
 * @param fields - The form's field names. Pass a stable array (a module constant).
 * @param credentialsField - Where `auth.invalid_credentials` is shown; none by default (it is
 *   then the form's).
 * @returns The messages by place: `form` and `fields[name]`.
 *
 * @example
 * ```tsx
 * const { error } = useSignIn()
 * const placed = useFieldErrors(error, ['email', 'password'], 'password')
 * // <TextField name='email' errors={placed.fields.email} />
 * // <FormError message={placed.form} />
 * ```
 */
export function useFieldErrors(
  error: TulaError | null,
  fields: readonly string[],
  credentialsField?: string
): PlacedErrors {
  return useMemo(
    () => placeErrors(error, fieldResolver(fields, credentialsField)),
    [error, fields, credentialsField]
  )
}
