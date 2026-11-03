import type { Context } from 'hono'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import * as logger from '~/lib/logger'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import * as Flows from '~/modules/flow/service'
import { OAUTH_INVALID_PAGE } from '~/modules/oauth/router'
import * as openapi from '~/openapi'

/** Requests per minute from one IP to an SSO connection's callback. */
export const SSO_CALLBACK_RATE_LIMIT = 30
/** Requests per minute to one connection's callback, from everywhere (ADR 0067). */
export const SSO_CONNECTION_CALLBACK_RATE_LIMIT = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Mounted at `/v1`: the redirect URI of every OIDC connection.
const router = new Hono<AppEnv>()

function field(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

router.get(
  '/sso/callback/:connectionId',
  describeRoute({
    operationId: 'ssoCallback',
    tags: ['SSO'],
    summary: 'SSO connection callback (OIDC redirect URI)',
    description:
      'Where an OIDC connection’s identity provider sends the browser back: the redirect URI ' +
      'to register with it. Not called by apps. As the OAuth provider callback: `state` works ' +
      'once, the code is exchanged server-side, and the browser is redirected (303) to the ' +
      'app’s page with a single-use ticket in the fragment (`#tula_ticket=…&tula_attempt=…`), ' +
      'which `POST /v1/client/sign-ins/oauth/exchange` redeems, or an error code there ' +
      '(`#tula_error=…`). A `state` that matches no sign-in gets a static page (400).',
    security: openapi.security.public,
    responses: {
      303: { description: 'Back to the app’s page.' },
      400: { description: 'The state matches no sign-in.' },
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  }),
  rateLimit({ name: 'sso_callback', limit: SSO_CALLBACK_RATE_LIMIT, window: '1m', key: byIp }),
  rateLimit({
    name: 'sso_callback_connection',
    limit: SSO_CONNECTION_CALLBACK_RATE_LIMIT,
    window: '1m',
    key: (c) => c.req.param('connectionId') ?? null,
  }),
  (c) => answer(c, c.req.query())
)

async function answer(c: Context<AppEnv>, input: Record<string, unknown>): Promise<Response> {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const connectionId = c.req.param('connectionId') ?? ''
  const result = UUID.test(connectionId)
    ? await Flows.ssoCallback(c.get('deps'), connectionId, {
        state: field(input.state),
        code: field(input.code),
        error: field(input.error),
      })
    : ({ invalid: true } as const)
  if ('redirectTo' in result) {
    try {
      return c.redirect(result.redirectTo, 303)
    } catch (error) {
      // As the OAuth callback: the state is spent, so the static page, and the reason by name.
      logger.error('sso callback: the redirect could not be built', {
        reason: error instanceof Error ? error.name : 'unknown',
      })
      c.header('Location', undefined)
    }
  }
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  return c.html(OAUTH_INVALID_PAGE, 400)
}

export default router
