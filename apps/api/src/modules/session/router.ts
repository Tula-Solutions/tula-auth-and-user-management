import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { AuthError } from '~/exceptions'
import { validationHook } from '~/handlers'
import { requestOrigin, userActor } from '~/lib/actor'
import { clientIp, ipBucket } from '~/lib/client-ip'
import { originMayUseCookies, requestMayUseSessionCookie } from '~/middleware/cors'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as Mfa from '~/modules/mfa/service'
import { PasskeyRequestOptionsSchema } from '~/modules/passkey/schema'
import * as Sessions from '~/modules/session/service'
import * as openapi from '~/openapi'
import {
  clearRefreshCookie,
  clearSessionCookie,
  readRefreshCookie,
  readSessionCookie,
  setRefreshCookie,
} from './cookies'
import {
  RefreshTokenRequestSchema,
  RevokedSessionsSchema,
  SessionIdParamSchema,
  SessionListSchema,
  SessionTokensSchema,
  SmsFactorCodeSchema,
  StepUpEmailCodeSchema,
  StepUpRequestSchema,
} from './schema'

/** Step-ups per minute from one IP; the service also limits wrong proofs per user. */
export const STEP_UP_RATE_LIMIT = 10

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
      'token again (within the `refresh.reuseGracePeriod` of the session’s profile). ' +
      'A browser whose session is of a `stateful` profile has no refresh token: called with ' +
      'only its session cookie, this answers `{ sessionId }` with no token when the session is ' +
      'still live (nothing is rotated), and 401 when it is not.',
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
    c.header('Cache-Control', 'no-store')
    if (!presented) {
      // No refresh token: a browser on a `stateful` profile has only its session cookie, and
      // asks here whether it is still signed in. Nothing is rotated and no token is returned.
      const sessionToken = readSessionCookie(c, deps.config, tenant.environmentId)
      if (!sessionToken || !(await requestMayUseSessionCookie(c))) {
        throw new AuthError('auth.unauthenticated')
      }
      try {
        const { sid } = await Sessions.authenticate(deps, tenant, sessionToken, requestOrigin(c))
        return c.json(SessionTokensSchema.parse({ sessionId: sid }))
      } catch (error) {
        if (error instanceof AuthError) {
          clearSessionCookie(c, deps.config, tenant.environmentId)
        }
        throw error
      }
    }
    try {
      const { refreshToken, cookieMaxAge, ...tokens } = await Sessions.refresh(
        deps,
        tenant,
        presented,
        requestOrigin(c)
      )
      if (fromCookie && refreshToken && cookieMaxAge) {
        // Browsers never see the refresh token in JavaScript.
        setRefreshCookie(c, deps.config, tenant.environmentId, refreshToken, cookieMaxAge)
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
      'Ends the session the refresh token (body or cookie) or the `stateful` session cookie ' +
      'belongs to and clears the cookie. ' +
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
    // A `stateful` session's cookie, under its own (stricter) rule: sign-out changes state.
    const sessionToken = readSessionCookie(c, deps.config, tenant.environmentId)
    if (sessionToken && (await requestMayUseSessionCookie(c))) {
      await Sessions.signOut(deps, tenant, sessionToken, requestOrigin(c))
      clearSessionCookie(c, deps.config, tenant.environmentId)
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
    // Devices, user agents and IP addresses of one user, which a cookie can now authenticate:
    // no cache may keep the answer and serve it to the next person at that browser.
    c.header('Cache-Control', 'no-store')
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
      if (readSessionCookie(c, deps.config, tenant.environmentId)) {
        clearSessionCookie(c, deps.config, tenant.environmentId)
      }
    }
    return c.body(null, 204)
  }
)

router.post(
  '/sessions/step-up',
  describeRoute({
    operationId: 'stepUpSession',
    tags: ['Sessions'],
    summary: 'Prove it is still me',
    description:
      'Proves a factor again for the current session and returns a fresh access token whose ' +
      '`auth_time` is now and whose `amr` includes the method (for a `stateful` session: ' +
      '`{ sessionId }` only; the session itself now carries the proof). Sensitive routes that ' +
      'answer `auth.step_up_required` accept it for ten minutes, or for the `stepUpAfter` of ' +
      'the session’s profile. A user with two-step ' +
      'verification must use `totp` or `backup_code` (their password alone answers ' +
      '`auth.step_up_required`); a user without it uses `password`, or an `email_code` asked ' +
      'for with `POST /v1/client/sessions/step-up/email-code` from this session. A user whose ' +
      '**only** second factor is a texted code uses the `sms_code` asked for with ' +
      '`POST /v1/client/sessions/step-up/sms-code` (recorded as `sms`, never `mfa`); beside ' +
      'an authenticator app or a passkey a texted code is not a method. A wrong ' +
      'password is `auth.invalid_credentials`, a wrong second-factor code `mfa.invalid_code`, ' +
      'a wrong emailed code `verification.invalid_code` (`verification.expired` once it is ' +
      'used, replaced or too old, `verification.too_many_attempts` after five guesses); wrong ' +
      'proofs back off per user. The refresh token is not rotated.',
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'A fresh access token.', content: json(SessionTokensSchema) },
      401: openapi.responses[401],
      403: openapi.responses[403],
      410: openapi.responses[410],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  rateLimit({ name: 'session_step_up', limit: STEP_UP_RATE_LIMIT, window: '1m', key: byIp }),
  publishableKey(),
  sessionAuth(),
  validator('json', StepUpRequestSchema, validationHook),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      SessionTokensSchema.parse(
        await Mfa.stepUp(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('json'),
          { ...requestOrigin(c), origin: c.req.header('origin') ?? null }
        )
      )
    )
  }
)

router.post(
  '/sessions/step-up/email-code',
  describeRoute({
    operationId: 'sendStepUpEmailCode',
    tags: ['Sessions'],
    summary: 'Email me a code to prove it is still me',
    description:
      'Emails the signed-in user a 6-digit code to step up with ' +
      '(`POST /v1/client/sessions/step-up`, method `email_code`). Only for a user with a ' +
      'verified email address and **no** second factor: anyone else gets ' +
      '`auth.step_up_required` (403) with `params.methods`, and nothing is sent. The code ' +
      'works for ten minutes, five guesses, once, and only for the session that asked; a new ' +
      'one replaces it. One code a minute and five an hour per user: sooner answers ' +
      '`rate_limited` (429) with `Retry-After`. The response never holds the code.',
    security: openapi.security.session,
    responses: {
      200: { description: 'The code was emailed.', content: json(StepUpEmailCodeSchema) },
      401: openapi.responses[401],
      403: openapi.responses[403],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  rateLimit({ name: 'session_step_up_email', limit: STEP_UP_RATE_LIMIT, window: '1m', key: byIp }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      StepUpEmailCodeSchema.parse(
        await Mfa.prepareStepUp(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          { method: 'email_code' }
        )
      )
    )
  }
)

router.post(
  '/sessions/step-up/sms-code',
  describeRoute({
    operationId: 'sendStepUpSmsCode',
    tags: ['Sessions'],
    summary: 'Text me a code to prove it is still me',
    description:
      'Texts the signed-in user a 6-digit code to step up with ' +
      '(`POST /v1/client/sessions/step-up`, method `sms_code`), to the phone number on the ' +
      'account. **Only for a user whose only second factor is a texted code**: anyone else ' +
      '(a user with an authenticator app or a passkey, and a user with no second factor) ' +
      'gets `auth.step_up_required` (403) with `params.methods`, and nothing is sent. The ' +
      'code works for ten minutes, five guesses, once, and only for the session that asked; ' +
      'a new one replaces it. `auth.method_disabled` where the environment has switched the ' +
      'texted second factor off; `sms.unavailable` (503) when the message could not be ' +
      'sent. The response never holds the code or the number.',
    security: openapi.security.session,
    responses: {
      200: { description: 'The code was texted.', content: json(SmsFactorCodeSchema) },
      401: openapi.responses[401],
      403: openapi.responses[403],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  rateLimit({ name: 'session_step_up_sms', limit: STEP_UP_RATE_LIMIT, window: '1m', key: byIp }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      SmsFactorCodeSchema.parse(
        await Mfa.prepareStepUpSms(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          { address: ipBucket(clientIp(c, c.get('deps').config.trustProxy)) }
        )
      )
    )
  }
)

router.post(
  '/sessions/step-up/passkey',
  describeRoute({
    operationId: 'getStepUpPasskeyOptions',
    tags: ['Sessions'],
    summary: 'Get the options to step up with a passkey',
    description:
      'The options for `navigator.credentials.get()`, naming the signed-in user’s own ' +
      'passkeys. Submit the assertion to `POST /v1/client/sessions/step-up` with ' +
      '`method: "passkey"`. The challenge works once, for five minutes and only for the ' +
      'session that asked; asking again replaces it. A user with no passkey gets ' +
      '`auth.step_up_required` (403) with `params.methods`. The request’s `Origin` must be ' +
      'one the environment allows and belong to its `passkeys.rpId`.',
    security: openapi.security.session,
    responses: {
      200: { description: 'The request options.', content: json(PasskeyRequestOptionsSchema) },
      401: openapi.responses[401],
      403: openapi.responses[403],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  rateLimit({
    name: 'session_step_up_passkey',
    limit: STEP_UP_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      PasskeyRequestOptionsSchema.parse(
        await Mfa.prepareStepUpPasskey(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.header('origin')
        )
      )
    )
  }
)

export default router
