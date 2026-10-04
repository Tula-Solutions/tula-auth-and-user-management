import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { AuthError } from '~/exceptions'
import { validationHook } from '~/handlers'
import { adminActor, requestOrigin } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Sessions from '~/modules/session/service'
import * as Users from '~/modules/user/service'
import * as openapi from '~/openapi'
import {
  AccessTokenClaimsSchema,
  RevokedSessionsSchema,
  SessionListSchema,
  UserIdParamSchema,
  UserSessionParamSchema,
  VerifySessionRequestSchema,
} from './schema'

const router = new Hono<AppEnv>()

router.post(
  '/sessions/verify',
  describeRoute({
    operationId: 'verifySession',
    tags: ['Sessions'],
    summary: 'Verify a session for a backend',
    description:
      'Checks a session on behalf of an application’s backend and answers with its claims ' +
      '(`sub`, `sid`, `auth_time`, `amr`, `sp`, …): the same shape an access token carries. ' +
      'A backend cannot verify the cookie of a `stateful` session offline, so it sends the ' +
      'cookie’s value here; `exp` says how long it may rely on the answer (one ' +
      '`accessTokenTtl` of the session’s profile) before asking again. A call counts as ' +
      'activity on the session. An access token of a `hybrid` session is accepted too ' +
      '(verified, then checked against the revoked-session list), for a backend that would ' +
      'rather not verify JWTs itself. A refresh token is never accepted. Unknown, revoked and ' +
      'expired sessions answer 401 with `session.invalid_token`, `session.revoked` or ' +
      '`session.expired`; a session of another environment is unknown.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The session’s claims.',
        content: { 'application/json': { schema: resolver(AccessTokenClaimsSchema) } },
      },
      401: openapi.responses[401],
      403: openapi.responses[403],
      413: openapi.responses[413],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', VerifySessionRequestSchema, validationHook),
  async (c) => {
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    const { token } = c.req.valid('json')
    c.header('Cache-Control', 'no-store')
    if (token.startsWith(Sessions.SESSION_TOKEN_PREFIX)) {
      const claims = await Sessions.authenticate(deps, tenant, token, requestOrigin(c))
      return c.json(AccessTokenClaimsSchema.parse(claims))
    }
    // Anything else must be an access token. A refresh token is not a JWT and fails here.
    const claims = await verifyAccessToken(deps, token, tenant)
    if (await deps.revokedSessions.has(claims.sid, deps.clock.now())) {
      throw new AuthError('session.revoked')
    }
    return c.json(AccessTokenClaimsSchema.parse(claims))
  }
)

router.delete(
  '/users/:userId/sessions',
  describeRoute({
    operationId: 'revokeUserSessions',
    tags: ['Sessions'],
    summary: 'Sign a user out everywhere',
    description:
      'Ends every session of a user (reason `revoked_by_admin`), each recorded in the audit ' +
      'log. A `stateful` session is refused on its very next request; a `hybrid` one cannot ' +
      'refresh any more and its access token is refused through the revoked-session list. ' +
      'Idempotent: a user with no live session answers `revoked: 0`. This is also how an ' +
      'operator frees a user who is kept out by the session limit ' +
      '(`sessions.onLimit: refuse_newest`). An unknown user answers 404.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'How many sessions ended.',
        content: { 'application/json': { schema: resolver(RevokedSessionsSchema) } },
      },
      401: openapi.responses[401],
      403: openapi.responses[403],
      404: openapi.responses[404],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  async (c) => {
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    const { userId } = c.req.valid('param')
    // 404 for a user this environment does not have, before anything is ended.
    await Users.get(deps, tenant, userId)
    const revoked = await Sessions.revokeAllForUser(
      deps,
      tenant,
      userId,
      'revoked_by_admin',
      adminActor(c)
    )
    return c.json(RevokedSessionsSchema.parse({ revoked }))
  }
)

router.get(
  '/users/:userId/sessions',
  describeRoute({
    operationId: 'listUserSessions',
    tags: ['Sessions'],
    summary: 'List a user’s sessions',
    description:
      'The active sessions of a user (their devices), most recently active first: client ' +
      'kind, user agent, IP address and times. Never token material. `current` is always ' +
      '`false`: the caller is not one of the user’s devices. An unknown user answers 404.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The user’s active sessions.',
        content: { 'application/json': { schema: resolver(SessionListSchema) } },
      },
      401: openapi.responses[401],
      403: openapi.responses[403],
      404: openapi.responses[404],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  async (c) => {
    const deps = c.get('deps')
    const tenant = c.get('tenant')
    const { userId } = c.req.valid('param')
    // 404 for a user this environment does not have, rather than an empty list.
    await Users.get(deps, tenant, userId)
    const data = await Sessions.list(deps, tenant, { userId, currentSessionId: '' })
    // Devices, user agents and IP addresses of one user: no cache may keep the answer.
    c.header('Cache-Control', 'no-store')
    return c.json(SessionListSchema.parse({ data }))
  }
)

router.delete(
  '/users/:userId/sessions/:sessionId',
  describeRoute({
    operationId: 'revokeUserSession',
    tags: ['Sessions'],
    summary: 'End one of a user’s sessions',
    description:
      'Ends one session of a user (reason `revoked_by_admin`), recorded in the audit log. ' +
      'Idempotent. A session that does not exist, belongs to another user or to another ' +
      'environment answers the same 404, so session ids cannot be probed.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'The session has ended.' },
      401: openapi.responses[401],
      403: openapi.responses[403],
      404: openapi.responses[404],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserSessionParamSchema, validationHook),
  async (c) => {
    const { userId, sessionId } = c.req.valid('param')
    // Through the session service, so the session's id is denylisted and its unexpired
    // access token stops working at once.
    await Sessions.revoke(c.get('deps'), c.get('tenant'), {
      userId,
      sessionId,
      reason: 'revoked_by_admin',
      actor: adminActor(c),
    })
    return c.body(null, 204)
  }
)

export default router
