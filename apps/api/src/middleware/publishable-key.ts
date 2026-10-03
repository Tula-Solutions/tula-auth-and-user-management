import { PUBLISHABLE_KEY_HEADER, PUBLISHABLE_KEY_PREFIX } from '@tula/contract'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { resolveApiKey } from '~/middleware/api-key'

/**
 * Header that carries the publishable key on `/v1/client/*` requests. Defined by the contract so
 * every SDK sends the same one.
 */
export { PUBLISHABLE_KEY_HEADER }

/**
 * Require a valid publishable key and set `c.var.tenant`.
 *
 * Publishable keys are embedded in apps and therefore public: they identify the environment but
 * authorize nothing sensitive on their own. User-scoped routes add `sessionAuth()`.
 *
 * @returns The middleware.
 * @throws AuthError `auth.invalid_key` (via the error handler).
 */
export function publishableKey() {
  return createMiddleware<AppEnv & { Variables: TenantVariables }>(async (c, next) => {
    const tenant = await resolveApiKey(
      c.get('deps'),
      c.req.header(PUBLISHABLE_KEY_HEADER),
      'publishable',
      PUBLISHABLE_KEY_PREFIX
    )
    c.set('tenant', tenant)
    await next()
  })
}
