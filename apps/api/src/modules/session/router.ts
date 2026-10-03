import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { AuthError } from '~/exceptions'
import { validationHook } from '~/handlers'
import { requestOrigin, userActor } from '~/lib/actor'
import { originMayUseCookies } from '~/middleware/cors'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as Sessions from '~/modules/session/service'
import * as openapi from '~/openapi'
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './cookies'
import {
  RefreshTokenRequestSchema,
  RevokedSessionsSchema,
  SessionIdParamSchema,
  SessionListSchema,
  SessionTokensSchema,
} from './schema'

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

router.post(
  '/sessions/refresh',
  describeRoute({
    operationId: 'refreshSession',
    tags: ['Sessions'],
    summary: 'Refresh a session',
    description:
      'Exchanges a refresh token for a new access token and the next refresh token. Native and ' +
      'server clients send `refreshToken` in the body and receive the next one in the response. ' +
      'Browsers send no body: the token travels in an httpOnly cookie and the next one is set ' +
      'the same way. The cookie is honoured only from an origin the environment allows ' +
      '(`urls.allowedOrigins`). Refresh tokens are single-use; presenting a used one signs the session ' +
      'out (`session.reuse_detected`), except for an immediate retry, which returns the same ' +
      'token again.',
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: { description: 'New tokens.', content: json(SessionTokensSchema) },
      401: openapi.responses[401],
      403: openapi.responses[403],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  // Each call is a database lookup by an unauthenticated caller.
  rateLimit({
    name: 'session_refresh',
    limit: Sessions.REFRESH_RATE_LIMIT,
    window: '1m',
    key: byIp,
    // Refresh needs only Postgres, and a refresh token is 256 bits: nothing here can be
    // guessed. If the limiter's store is down, signed-in users must still be able to refresh
    // rather than all be signed out when their access tokens expire (ADR 0016).
    whenUnavailable: 'allow',
  }),
  publishableKey(),
  validator('json', RefreshTokenRequestSchema, validationHook),
  async (c) => {
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    const fromBody = c.req.valid('json').refreshToken
    // The cookie counts only from an origin this environment allows: the browser attaches it
    // to any request, whoever wrote the page that made it.
    const fromCookie =
      fromBody || !(await originMayUseCookies(c))
        ? undefined
        : readRefreshCookie(c, deps.config, tenant.environmentId)
    const presented = fromBody ?? fromCookie
    if (!presented) {
      throw new AuthError('auth.unauthenticated')
    }
    c.header('Cache-Control', 'no-store')
    try {
      const { refreshToken, ...tokens } = await Sessions.refresh(
        deps,
        tenant,
        presented,
        requestOrigin(c)
      )
      if (fromCookie && refreshToken) {
        // Browsers never see the refresh token in JavaScript.
        setRefreshCookie(c, deps.config, tenant.environmentId, refreshToken)
        return c.json(SessionTokensSchema.parse(tokens))
      }
      return c.json(SessionTokensSchema.parse({ ...tokens, refreshToken }))
    } catch (error) {
      if (fromCookie && error instanceof AuthError) {
        // The cookie can never work again; drop it so the browser stops sending it.
        clearRefreshCookie(c, deps.config, tenant.environmentId)
      }
      throw error
    }
  }
)

router.post(
  '/sessions/sign-out',
  describeRoute({
    operationId: 'signOut',
    tags: ['Sessions'],
    summary: 'Sign out',
    description:
      'Ends the session the refresh token (body or cookie) belongs to and clears the cookie. ' +
      'Always succeeds, including when the token is missing or unknown, so a client can sign ' +
      'out with an expired access token.',
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      204: { description: 'Signed out.' },
      401: openapi.responses[401],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  publishableKey(),
  validator('json', RefreshTokenRequestSchema, validationHook),
  async (c) => {
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    // A page on an origin this environment does not allow can neither end the cookie's session
    // nor make the browser drop the cookie.
    const cookies = await originMayUseCookies(c)
    const presented =
      c.req.valid('json').refreshToken ??
      (cookies ? readRefreshCookie(c, deps.config, tenant.environmentId) : undefined)
    await Sessions.signOut(deps, tenant, presented, requestOrigin(c))
    if (cookies) {
      clearRefreshCookie(c, deps.config, tenant.environmentId)
    }
    return c.body(null, 204)
  }
)

router.get(
  '/sessions',
  describeRoute({
    operationId: 'listSessions',
    tags: ['Sessions'],
    summary: 'List my sessions',
    description: 'The signed-in user’s active devices, most recently active first.',
    security: openapi.security.session,
    responses: {
      200: { description: 'Active sessions.', content: json(SessionListSchema) },
      401: openapi.responses[401],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    const { sub, sid } = c.get('session')
    const data = await Sessions.list(c.get('deps'), c.get('tenant'), {
      userId: sub,
      currentSessionId: sid,
    })
    return c.json(SessionListSchema.parse({ data }))
  }
)

router.post(
  '/sessions/revoke-others',
  describeRoute({
    operationId: 'revokeOtherSessions',
    tags: ['Sessions'],
    summary: 'Sign out my other devices',
    description: 'Ends every session of the signed-in user except the one making the request.',
    security: openapi.security.session,
    responses: {
      200: { description: 'How many sessions ended.', content: json(RevokedSessionsSchema) },
      401: openapi.responses[401],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    const { sub, sid } = c.get('session')
    const revoked = await Sessions.revokeOthers(c.get('deps'), c.get('tenant'), {
      userId: sub,
      currentSessionId: sid,
      actor: userActor(c),
    })
    return c.json(RevokedSessionsSchema.parse({ revoked }))
  }
)

router.delete(
  '/sessions/:sessionId',
  describeRoute({
    operationId: 'revokeSession',
    tags: ['Sessions'],
    summary: 'Sign out one of my devices',
    description:
      'Ends one of the signed-in user’s sessions. A session that does not exist and one that ' +
      'belongs to someone else both answer 404.',
    security: openapi.security.session,
    responses: {
      204: { description: 'The session ended.' },
      401: openapi.responses[401],
      404: openapi.responses[404],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', SessionIdParamSchema, validationHook),
  async (c) => {
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    const { sub, sid } = c.get('session')
    const { sessionId } = c.req.valid('param')
    await Sessions.revoke(deps, tenant, { userId: sub, sessionId, actor: userActor(c) })
    if (sessionId === sid) {
      clearRefreshCookie(c, deps.config, tenant.environmentId)
    }
    return c.body(null, 204)
  }
)

export default router
