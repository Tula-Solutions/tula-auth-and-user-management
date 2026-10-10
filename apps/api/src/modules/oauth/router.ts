import { OAUTH_PROVIDERS, type OAuthProvider } from '@tula/contract'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor, userActor } from '~/lib/actor'
import { clientIp } from '~/lib/client-ip'
import * as logger from '~/lib/logger'
import { originMayUseCookies } from '~/middleware/cors'
import { publishableKey } from '~/middleware/publishable-key'
import { adminRateLimit, byIp, rateLimit } from '~/middleware/rate-limit'
import { requireRecentAuth } from '~/middleware/recent-auth'
import { secretKey } from '~/middleware/secret-key'
import { sessionAuth } from '~/middleware/session-auth'
import * as Flows from '~/modules/flow/service'
import * as OAuth from '~/modules/oauth/service'
import * as openapi from '~/openapi'
import {
  IdentityIdParamSchema,
  IdentityLinkStartSchema,
  IdentityListSchema,
  IdentitySchema,
  OAuthExchangeRequestSchema,
  OAuthProviderSettingsListSchema,
  OAuthProviderSettingsSchema,
  OAuthProviderUpdateSchema,
  OAuthStartRequestSchema,
  ProviderParamSchema,
} from './schema'

/** Provider callbacks per minute from one IP. Each one may cost a request to the provider. */
export const OAUTH_CALLBACK_RATE_LIMIT = 30
/** Requests per minute from one IP to each route that changes a user's connected accounts. */
export const IDENTITY_RATE_LIMIT = 10

/**
 * What a browser is shown when a provider's answer matches no sign-in, so there is no app page
 * to send it to. A constant: nothing from the request is ever written into it.
 */
export const OAUTH_INVALID_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Sign-in could not be completed</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">' +
  '<h1 style="font-size:1.25rem">Sign-in could not be completed</h1>' +
  '<p>This sign-in link is not valid or has already been used. ' +
  'Go back to the app and start again.</p></body></html>'

// Mounted at `/v1`: admin provider settings, the public provider callback, and the signed-in
// user's connected accounts.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const limited = (name: string, limit = IDENTITY_RATE_LIMIT) =>
  rateLimit({ name, limit, window: '1m', key: byIp })

const errors = {
  401: openapi.responses[401],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const STEP_UP =
  ' Needs a recent authentication: otherwise it answers `auth.step_up_required` (403) with ' +
  '`params.methods`; call `POST /v1/client/sessions/step-up` and repeat the request.'

router.get(
  '/admin/oauth-providers',
  describeRoute({
    operationId: 'listOAuthProviders',
    tags: ['OAuth'],
    summary: 'List OAuth providers',
    description:
      'Every provider (Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X, Facebook), configured or not: whether credentials are ' +
      'stored and sign-in offers it, the client id, and `callbackUrl`, the redirect URI to ' +
      'paste into the provider’s console exactly. Never a secret.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The providers.', content: json(OAuthProviderSettingsListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      OAuthProviderSettingsListSchema.parse({
        data: await OAuth.list(c.get('deps'), c.get('tenant')),
      })
    )
  }
)

router.put(
  '/admin/oauth-providers/:provider',
  describeRoute({
    operationId: 'updateOAuthProvider',
    tags: ['OAuth'],
    summary: 'Set an OAuth provider’s credentials',
    description:
      'Stores the environment’s own credentials for the provider and whether sign-in offers ' +
      'it. Google, GitHub, Discord, LinkedIn, X and Facebook take `clientId` and `clientSecret`; Apple takes `clientId` (the ' +
      'Services ID), `teamId`, `keyId` and `privateKey` (the `.p8` file’s PEM); Microsoft ' +
      'takes `clientId`, `clientSecret` and `tenant` (`common`, `organizations`, `consumers` ' +
      'or a tenant id: which accounts may sign in). The secret is ' +
      'stored encrypted and never returned; leave it out to keep the stored one. Recorded in ' +
      'the audit log by key, never by value. `enabled: false` is refused (422) when it would ' +
      'leave the environment with no way to sign in.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The provider.', content: json(OAuthProviderSettingsSchema) },
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', ProviderParamSchema, validationHook),
  validator('json', OAuthProviderUpdateSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      OAuthProviderSettingsSchema.parse(
        await OAuth.update(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').provider,
          c.req.valid('json'),
          adminActor(c)
        )
      )
    )
  }
)

router.delete(
  '/admin/oauth-providers/:provider',
  describeRoute({
    operationId: 'deleteOAuthProvider',
    tags: ['OAuth'],
    summary: 'Remove an OAuth provider’s credentials',
    description:
      'Removes the stored credentials; sign-in stops offering the provider. Users keep their ' +
      'connected accounts of it, so configuring it again lets them back in. Refused (422) ' +
      'when it would leave the environment with no way to sign in. It is not refused because ' +
      'some user has no other way in: such a user sets a password through a password reset.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'Removed.' },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', ProviderParamSchema, validationHook),
  async (c) => {
    await OAuth.remove(c.get('deps'), c.get('tenant'), c.req.valid('param').provider, adminActor(c))
    return c.body(null, 204)
  }
)

function isProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value)
}

function field(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Answer a provider's callback: a redirect to the app's allow-listed page, or the static page.
 * Never a cookie, never a token, never anything the provider sent.
 */
async function answerCallback(
  c: Context<AppEnv>,
  input: Record<string, unknown>
): Promise<Response> {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const provider = c.req.param('provider') ?? ''
  const result = isProvider(provider)
    ? await Flows.oauthCallback(c.get('deps'), provider, {
        state: field(input.state),
        code: field(input.code),
        error: field(input.error),
        user: field(input.user),
      })
    : ({ invalid: true } as const)
  if ('redirectTo' in result) {
    try {
      // 303: the browser follows with a GET, also after Apple's form post.
      return c.redirect(result.redirectTo, 303)
    } catch (error) {
      // A destination no header can carry (a control character in a stored redirect URL:
      // no save accepts one, but the state is spent by now and a 500 would say nothing to
      // the person in front of the browser). The static page, and the reason by name only:
      // the runtime's message quotes the value.
      logger.error('oauth callback: the redirect could not be built', {
        provider,
        reason: error instanceof Error ? error.name : 'unknown',
      })
      c.header('Location', undefined)
    }
  }
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  return c.html(OAUTH_INVALID_PAGE, 400)
}

const callbackDocs = (operationId: string, how: string) =>
  describeRoute({
    operationId,
    tags: ['OAuth'],
    summary: `Provider callback (${how})`,
    description:
      'Where a provider sends the browser back (the redirect URI registered with it). Not ' +
      'called by apps. `state` is the only link to the sign-in and works once. The code is ' +
      'exchanged server-side, and the browser is redirected (303) to the page of the app the ' +
      'sign-in named, with a single-use, 60-second ticket in the URL fragment ' +
      '(`#tula_ticket=…&tula_attempt=…`) or an error code there (`#tula_error=…`). Sets no ' +
      'cookie and returns no token. A `state` that matches no sign-in gets a static page (400).',
    security: openapi.security.public,
    responses: {
      303: { description: 'Back to the app’s page.' },
      400: { description: 'The state matches no sign-in.' },
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  })

router.get(
  '/oauth/callback/:provider',
  callbackDocs('oauthCallback', 'query'),
  limited('oauth_callback', OAUTH_CALLBACK_RATE_LIMIT),
  (c) => answerCallback(c, c.req.query())
)

router.post(
  '/oauth/callback/:provider',
  callbackDocs('oauthCallbackFormPost', 'form post, Apple'),
  limited('oauth_callback', OAUTH_CALLBACK_RATE_LIMIT),
  async (c) => {
    let form: Record<string, unknown> = {}
    try {
      form = await c.req.parseBody()
    } catch {
      // An unreadable body is a callback with no state.
    }
    return answerCallback(c, form)
  }
)

/** The requesting device of a signed-in user's request, and whether its origin is allowed. */
async function clientContext<E extends AppEnv & { Variables: TenantVariables }>(
  c: Context<E>
): Promise<Flows.ClientContext> {
  return {
    client: 'web',
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress: clientIp(c, c.get('deps').config.trustProxy),
    originAllowed: await originMayUseCookies(c),
  }
}

router.get(
  '/client/me/identities',
  describeRoute({
    operationId: 'listMyIdentities',
    tags: ['OAuth'],
    summary: 'List my connected accounts',
    description:
      'The provider accounts (Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X, Facebook) connected to the signed-in user. Never ' +
      'the provider’s own id for an account.',
    security: openapi.security.session,
    responses: {
      200: { description: 'The connected accounts.', content: json(IdentityListSchema) },
      ...errors,
    },
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      IdentityListSchema.parse({
        data: await OAuth.identities(c.get('deps'), c.get('tenant'), c.get('session').sub),
      })
    )
  }
)

router.post(
  '/client/me/identities/oauth',
  describeRoute({
    operationId: 'startIdentityLink',
    tags: ['OAuth'],
    summary: 'Start connecting a provider account',
    description:
      'Starts an OAuth round trip that connects the provider account to the signed-in user, ' +
      'whatever email the provider reports. Answers like `sign-ins/oauth`: send the browser ' +
      'to `authorizationUrl`, keep `binding`, and post the ticket the page receives to ' +
      '`me/identities/oauth/exchange`.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      200: {
        description: 'The provider’s URL and the binding.',
        content: json(IdentityLinkStartSchema),
      },
      400: openapi.responses[400],
      403: openapi.responses[403],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('identity_link_start'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('json', OAuthStartRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      IdentityLinkStartSchema.parse(
        await Flows.startOAuthLink(
          c.get('deps'),
          c.get('tenant'),
          c.get('session').sub,
          c.req.valid('json'),
          await clientContext(c)
        )
      )
    )
  }
)

router.post(
  '/client/me/identities/oauth/exchange',
  describeRoute({
    operationId: 'exchangeIdentityLinkTicket',
    tags: ['OAuth'],
    summary: 'Finish connecting a provider account',
    description:
      'Exchanges the ticket of a link started by the signed-in user, with the binding this ' +
      'browser was given. Connects the provider account to that user. ' +
      '`oauth.identity_in_use`: it belongs to another user. `oauth.already_linked`: the user ' +
      'already has an account of this provider. Creates no session.',
    security: openapi.security.session,
    responses: {
      200: { description: 'The connected account.', content: json(IdentitySchema) },
      403: openapi.responses[403],
      409: openapi.responses[409],
      410: openapi.responses[410],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('identity_link_exchange'),
  publishableKey(),
  sessionAuth(),
  validator('json', OAuthExchangeRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      IdentitySchema.parse(
        await Flows.exchangeOAuthLink(
          c.get('deps'),
          c.get('tenant'),
          c.get('session').sub,
          c.req.valid('json'),
          await clientContext(c),
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/client/me/identities/:identityId',
  describeRoute({
    operationId: 'deleteMyIdentity',
    tags: ['OAuth'],
    summary: 'Disconnect a provider account',
    description:
      'Disconnects the provider account from the signed-in user. Refused with ' +
      '`identity.last_sign_in_method` (409) when nothing else would let them sign in: no ' +
      'password (where passwords are on), no verified email (where the email code is on) and ' +
      'no other connected account of an enabled provider.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      204: { description: 'Disconnected.' },
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('identity_unlink'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('param', IdentityIdParamSchema, validationHook),
  async (c) => {
    await OAuth.unlink(
      c.get('deps'),
      c.get('tenant'),
      c.get('session').sub,
      c.req.valid('param').identityId,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
