/**
 * Names of the request headers the client API reads, and of the two parameters an emailed
 * sign-in link carries in its URL fragment.
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

/**
 * Name of the URL-fragment parameter carrying an emailed sign-in link's token.
 *
 * The link is the app's own URL followed by `#tula_link=<token>&tula_attempt=<attempt id>`. A
 * fragment is never sent to a server, a proxy or in `Referer`, so the token reaches only the
 * page's own script, which posts it to `/v1/client/sign-ins/link` and removes it from the URL.
 *
 * @example
 * ```ts
 * const token = new URLSearchParams(location.hash.slice(1)).get(EMAIL_LINK_TOKEN_PARAM)
 * ```
 */
export const EMAIL_LINK_TOKEN_PARAM = 'tula_link'

/**
 * Name of the URL-fragment parameter carrying the id of the sign-in an emailed link belongs to.
 *
 * @example
 * ```ts
 * const attemptId = new URLSearchParams(location.hash.slice(1)).get(EMAIL_LINK_ATTEMPT_PARAM)
 * ```
 */
export const EMAIL_LINK_ATTEMPT_PARAM = 'tula_attempt'
