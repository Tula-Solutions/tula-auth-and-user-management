import { createMiddleware } from 'hono/factory'
import type { AppEnv, SessionVariables, TenantVariables } from '~/dependencies'
import * as Mfa from '~/modules/mfa/service'

/**
 * Require that the signed-in user proved who they are recently (a "step-up"), for a sensitive
 * route. Must run after `sessionAuth()`.
 *
 * The decision is made from the session's `auth_time` and `amr` claims
 * (`Mfa.requireRecentAuthentication`), which `sessionAuth()` took from the verified access
 * token or, for a `stateful` session, from the session row it had just read. How recent is
 * recent enough is the `stepUpAfter` of the session's profile (the `sp` claim), ten minutes
 * when the profile sets none (ADR 0028). A client that gets
 * `auth.step_up_required` calls `POST /v1/client/sessions/step-up` with one of
 * `params.methods`, receives a fresh access token, and repeats the request.
 *
 * @param options - `maxAgeSeconds` to fix the window for one route whatever the profile says
 *   (default: the profile's `stepUpAfter`, else `STEP_UP_MAX_AGE_SECONDS`, ten minutes), and
 *   `onlyWithSecondFactor` to hold only users who have a second factor to it.
 * @returns The middleware.
 * @throws AuthError `auth.step_up_required` (403).
 *
 * @example
 * ```ts
 * router.delete('/me/factors/totp', publishableKey(), sessionAuth(), requireRecentAuth(), handler)
 * ```
 */
export function requireRecentAuth(options: Mfa.RecentAuthenticationOptions = {}) {
  return createMiddleware<AppEnv & { Variables: TenantVariables & SessionVariables }>(
    async (c, next) => {
      await Mfa.requireRecentAuthentication(
        c.get('deps'),
        c.get('tenant'),
        c.get('session'),
        options
      )
      await next()
    }
  )
}
