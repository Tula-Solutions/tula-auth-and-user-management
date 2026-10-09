import type { UserRecord } from '~/ports/user-repository'

/** What an account with neither an address nor a name is called. */
const NAMELESS = 'Account'

/**
 * What an account is called where a label for it is shown to its own user: beside an
 * authenticator app's entry, in a passkey manager.
 *
 * The address, when the account has one. An account without one (made by a first sign-in
 * with X or Facebook; ADR 0026) is called by its name, and by a fixed word when it has
 * neither: never by a provider's id for it, which is not the user's to see.
 *
 * The name of such an account is text the provider's profile carried. It goes only where the
 * address would: into a value the caller encodes for its place (a URI component, a JSON
 * string), never into markup, a log line or an email.
 *
 * @param user - The account.
 * @returns The label, never empty.
 *
 * @example
 * ```ts
 * accountLabel({ email: null, firstName: 'Maya', lastName: null }) // 'Maya'
 * ```
 */
export function accountLabel(user: Pick<UserRecord, 'email' | 'firstName' | 'lastName'>): string {
  return (
    user.email ?? ([user.firstName, user.lastName].filter(Boolean).join(' ').trim() || NAMELESS)
  )
}
