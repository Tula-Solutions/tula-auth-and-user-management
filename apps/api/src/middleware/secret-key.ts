import { SECRET_KEY_PREFIX } from '@tula/contract'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { bearerToken, resolveApiKey } from '~/middleware/api-key'

/**
 * Require a valid secret key (`Authorization: Bearer tula_sk_…`) and set `c.var.tenant`.
 *
 * @returns The middleware.
 * @throws AuthError `auth.invalid_key` (via the error handler).
 */
export function secretKey() {
  return createMiddleware<AppEnv & { Variables: TenantVariables }>(async (c, next) => {
    const tenant = await resolveApiKey(
      c.get('deps'),
      bearerToken(c.req.header('authorization')),
      'secret',
      SECRET_KEY_PREFIX
    )
    c.set('tenant', tenant)
    await next()
  })
}
