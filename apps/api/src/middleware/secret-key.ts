import { ENVIRONMENT_HEADER, SECRET_KEY_PREFIX } from '@tula/contract'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, Tenant, TenantVariables } from '~/dependencies'
import { BadRequestError, NotFoundError } from '~/exceptions'
import { bearerToken, resolveApiKey } from '~/middleware/api-key'
import { isDashboardRequest, requireDashboardSession } from '~/middleware/dashboard-session'

/** The shape of an environment id; anything else never reaches the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve the tenant of an admin request made by the dashboard: a valid session, plus the
 * environment named in `x-tula-environment`.
 *
 * The operator's authority covers every environment of the deployment, so any environment that
 * exists resolves. The project is read from the environment's own row, never from the request:
 * project and environment can not disagree. A malformed id and an unknown one get the same 404.
 *
 * @param c - The request context.
 * @returns The tenant, with no API key id.
 * @throws BadRequestError when an `Authorization` header is present too, or the environment
 *   header is missing.
 * @throws UnauthorizedError `auth.unauthenticated` without a valid session.
 * @throws AuthError `request.origin_not_allowed` when the request breaks the CSRF rules.
 * @throws NotFoundError when the environment does not exist.
 */
async function resolveDashboardTenant<E extends AppEnv>(c: Context<E>): Promise<Tenant> {
  // The session first: nothing about environments is told to a request that has none.
  await requireDashboardSession(c)
  const environmentId = c.req.header(ENVIRONMENT_HEADER)
  if (environmentId === undefined) {
    throw new BadRequestError({
      message: `A dashboard request to an admin route names its environment in ${ENVIRONMENT_HEADER}.`,
    })
  }
  const environment = UUID.test(environmentId)
    ? await c.get('deps').environments.findById(environmentId.toLowerCase())
    : null
  if (!environment) {
    throw new NotFoundError({ message: 'That environment does not exist.' })
  }
  return { projectId: environment.projectId, environmentId: environment.id, apiKeyId: '' }
}

/**
 * Authorize an `/v1/admin/*` request and set `c.var.tenant`. Every admin route uses this one
 * middleware, so both credentials work on all of them and neither can be forgotten on one.
 *
 * - **A secret key** (`Authorization: Bearer tula_sk_…`) resolves its own environment.
 * - **A dashboard session** (ADR 0032): a request that carries `x-tula-dashboard` is
 *   authenticated by the session cookie, under the CSRF rules, and names its environment in
 *   `x-tula-environment`. `c.var.dashboard` is set, which makes `adminActor(c)` an
 *   `instance_admin`.
 *
 * The two are never mixed: a request with the dashboard header or the environment header **and**
 * an `Authorization` header is refused (400), so a key can never act on an environment a header
 * chose, and a session never lends itself to a key. A bare session cookie beside a secret key
 * is ignored, not refused: the browser attaches it by itself to every same-site request, and
 * the key alone decides. The instance admin token is not accepted here: it authorizes
 * `/v1/instance/*` only.
 *
 * @returns The middleware.
 * @throws AuthError `auth.invalid_key` (via the error handler) for a missing or wrong key.
 * @throws BadRequestError, UnauthorizedError, NotFoundError as {@link resolveDashboardTenant}.
 */
export function secretKey() {
  return createMiddleware<AppEnv & { Variables: TenantVariables }>(async (c, next) => {
    if (isDashboardRequest(c)) {
      c.set('tenant', await resolveDashboardTenant(c))
    } else {
      if (c.req.header(ENVIRONMENT_HEADER) !== undefined) {
        throw new BadRequestError({
          message: `${ENVIRONMENT_HEADER} belongs to a dashboard session; a secret key names its own environment.`,
        })
      }
      c.set(
        'tenant',
        await resolveApiKey(
          c.get('deps'),
          bearerToken(c.req.header('authorization')),
          'secret',
          SECRET_KEY_PREFIX
        )
      )
    }
    await next()
  })
}
