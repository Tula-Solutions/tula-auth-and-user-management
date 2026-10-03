/**
 * Names of the request headers the client API reads.
 *
 * This module has no dependencies (no Zod), so an SDK can import it from
 * `@tula/contract/headers` without adding anything to an application's bundle.
 */

/**
 * Request header carrying the publishable key (`tula_pk_<env>_…`) on every `/v1/client/*` call.
 * It names the project and environment the request belongs to.
 *
 * @example
 * ```ts
 * await fetch(`${api}/v1/client/config`, { headers: { [PUBLISHABLE_KEY_HEADER]: key } })
 * ```
 */
export const PUBLISHABLE_KEY_HEADER = 'x-tula-publishable-key'

/**
 * Request header naming the kind of client (`web`, `ios`, `android` or `server`), read when an
 * attempt starts. It decides how the refresh token is delivered when the flow completes: an
 * httpOnly cookie for `web` (the default), the response body for the others.
 *
 * @example
 * ```ts
 * await fetch(`${api}/v1/client/sign-ins`, {
 *   method: 'POST',
 *   headers: { [CLIENT_HEADER]: 'ios', ...others },
 *   body: JSON.stringify({ identifier }),
 * })
 * ```
 */
export const CLIENT_HEADER = 'x-tula-client'

/**
 * Request header carrying an attempt's secret.
 *
 * Starting a sign-up, sign-in or password reset returns `attemptSecret` once; every later call
 * on that attempt sends it in this header. Without it (or with another attempt's) the attempt
 * answers `flow.not_found`, so an attempt id seen in a URL, a log or an email is useless alone.
 *
 * @example
 * ```ts
 * await fetch(`${api}/v1/client/sign-ins/${attempt.id}/password`, {
 *   method: 'POST',
 *   headers: { [FLOW_ATTEMPT_HEADER]: attempt.attemptSecret, ...others },
 *   body: JSON.stringify({ password }),
 * })
 * ```
 */
export const FLOW_ATTEMPT_HEADER = 'x-tula-attempt'
