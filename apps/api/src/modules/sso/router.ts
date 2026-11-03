import type { Context } from 'hono'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import * as logger from '~/lib/logger'
import { buildSpMetadata } from '~/lib/saml-metadata'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import * as Flows from '~/modules/flow/service'
import { OAUTH_INVALID_PAGE } from '~/modules/oauth/router'
import { samlUrls } from '~/modules/sso-connection/service'
import * as SsoTests from '~/modules/sso-test/service'
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

router.get(
  '/environments/:environmentId/sso/saml/:connectionId/metadata',
  describeRoute({
    operationId: 'ssoSamlMetadata',
    tags: ['SSO'],
    summary: 'SAML service provider metadata of a connection',
    description:
      'The SAML metadata of a connection’s service provider: its entity id (this address), ' +
      'an assertion consumer service with the HTTP-POST binding and the email NameID format. ' +
      'Public and stable; it holds no secret. Give this address, or the values, to the ' +
      'identity provider.',
    security: openapi.security.public,
    responses: {
      200: { description: 'The metadata XML.', content: { 'application/samlmetadata+xml': {} } },
      404: openapi.responses[404],
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  }),
  rateLimit({ name: 'sso_saml_metadata', limit: SSO_CALLBACK_RATE_LIMIT, window: '1m', key: byIp }),
  async (c) => {
    const { environmentId, connectionId } = c.req.param()
    const connection =
      UUID.test(environmentId ?? '') && UUID.test(connectionId ?? '')
        ? await c.get('deps').ssoConnections.find(environmentId as string, connectionId as string)
        : null
    if (connection?.protocol !== 'saml') {
      return c.json({ status: 404, code: 'not_found', detail: 'Not found.' }, 404)
    }
    const urls = samlUrls(c.get('deps').config, connection)
    return c.body(buildSpMetadata({ entityId: urls.spEntityId, acsUrl: urls.acsUrl }), 200, {
      'Content-Type': 'application/samlmetadata+xml; charset=utf-8',
    })
  }
)

router.post(
  '/environments/:environmentId/sso/saml/:connectionId/acs',
  describeRoute({
    operationId: 'ssoSamlAcs',
    tags: ['SSO'],
    summary: 'SAML assertion consumer service of a connection',
    description:
      'Where a SAML identity provider posts its response (`SAMLResponse` and `RelayState`, ' +
      'form-encoded). Not called by apps. Only a response to a sign-in this server started is ' +
      'taken (IdP-initiated responses are refused). It is checked as the OIDC callback’s ' +
      'answer is: the browser is redirected (303) to the app’s page with a single-use ticket ' +
      'in the fragment, or with `#tula_error=sso.provider_error` for every refusal; the reason ' +
      'is logged and never shown. A `RelayState` that matches no sign-in gets a static page (400).',
    security: openapi.security.public,
    responses: {
      303: { description: 'Back to the app’s page.' },
      400: { description: 'The state matches no sign-in.' },
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  }),
  rateLimit({ name: 'sso_acs', limit: SSO_CALLBACK_RATE_LIMIT, window: '1m', key: byIp }),
  rateLimit({
    name: 'sso_acs_connection',
    limit: SSO_CONNECTION_CALLBACK_RATE_LIMIT,
    window: '1m',
    key: (c) => c.req.param('connectionId') ?? null,
  }),
  async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    return answer(c, { state: form.RelayState, samlResponse: form.SAMLResponse })
  }
)

async function answer(c: Context<AppEnv>, input: Record<string, unknown>): Promise<Response> {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const connectionId = c.req.param('connectionId') ?? ''
  const state = field(input.state)
  // A test sign-in's state is taken by the test; anything else is a sign-in's.
  const test = UUID.test(connectionId)
    ? await SsoTests.callback(c.get('deps'), connectionId, {
        state,
        code: field(input.code),
        error: field(input.error),
        samlResponse: field(input.samlResponse),
      })
    : null
  const result =
    test ??
    (UUID.test(connectionId)
      ? await Flows.ssoCallback(c.get('deps'), connectionId, {
          state: field(input.state),
          code: field(input.code),
          error: field(input.error),
          samlResponse: field(input.samlResponse),
        })
      : ({ invalid: true } as const))
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
