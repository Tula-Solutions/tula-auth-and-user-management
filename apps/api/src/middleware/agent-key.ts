import { AGENT_KEY_PREFIX } from '@tula/contract'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { bearerToken, resolveApiKey } from '~/middleware/api-key'

/**
 * Authorize an `/v1/agent/*` request and set `c.var.tenant` (ADR 0051).
 *
 * The group holds what an AI agent may ask for and nothing else: today, a proposal. It takes
 * an **agent key** (`Authorization: Bearer tula_ak_…`) and no other credential: a secret key,
 * a publishable key, the instance admin token and a dashboard session are all answered like a
 * wrong key. A human who wants a change makes it; only an agent proposes one, which is what
 * lets every proposal be recorded with the `agent` actor.
 *
 * An agent key opens exactly two things: a read of `/v1/admin/*` (`secretKey()`) and this
 * group. Never add a route here that changes anything by itself.
 *
 * @returns The middleware.
 * @throws AuthError `auth.invalid_key` (via the error handler) for a missing or wrong key.
 */
export function agentKey() {
  return createMiddleware<AppEnv & { Variables: TenantVariables }>(async (c, next) => {
    const tenant = await resolveApiKey(
      c.get('deps'),
      bearerToken(c.req.header('authorization')),
      'agent',
      AGENT_KEY_PREFIX
    )
    c.set('tenant', { ...tenant, agent: true })
    await next()
  })
}
