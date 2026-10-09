import type { FirstFactorAttemptRequest, FlowKind } from '@tula/contract'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { z } from 'zod'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { validationHook } from '~/handlers'
import { clientIp } from '~/lib/client-ip'
import { originMayUseCookies } from '~/middleware/cors'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import * as Flows from '~/modules/flow/service'
import { setRefreshCookie, setSessionCookie } from '~/modules/session/cookies'
import * as openapi from '~/openapi'
import {
  AttemptHeaderSchema,
  AttemptIdParamSchema,
  CLIENT_HEADER,
  ClientHeaderSchema,
  EmailLinkRequestSchema,
  EmailLinkResultSchema,
  FirstFactorAttemptRequestSchema,
  FirstFactorPrepareRequestSchema,
  FLOW_ATTEMPT_HEADER,
  FlowAttemptSchema,
  NewPasswordRequestSchema,
  OAuthExchangeRequestSchema,
  OAuthStartRequestSchema,
  OAuthStartSchema,
  PasskeyRequestOptionsSchema,
  PasskeySignInRequestSchema,
  PasskeySignInStartSchema,
  PasswordAttemptRequestSchema,
  PasswordResetRequestSchema,
  PasswordResetStartRequestSchema,
  SESSION_PROFILE_HEADER,
  SecondFactorRequestSchema,
  SignInStartRequestSchema,
  SignUpRequestSchema,
  TotpConfirmRequestSchema,
  TotpEnrolmentSchema,
  VerifyEmailRequestSchema,
} from './schema'

/** Sign-ups per minute from one IP. Each one hashes a password and sends an email. */
export const SIGN_UP_RATE_LIMIT = 10
/**
 * Requests per minute from one IP to each credential step (sign-in start, password, code).
 * Resending a code uses the tighter sign-up limit, since it sends an email. The service adds per-environment ceilings, per-identifier lockout and per-address
 * email limits on top.
 */
export const CREDENTIAL_RATE_LIMIT = 30
/**
 * Requests per minute from one IP asking whether an emailed link has been opened
 * (`first-factor/attempt` with `email_link`). A waiting tab asks every three seconds, twenty
 * times a minute, and many people share one address behind a NAT: this leaves room for fifteen
 * of them. An unopened link's answer is one read and nothing guessable sits behind it, so the
 * limit only bounds load. It is a bucket of its own, so that people waiting for links never
 * use up the allowance of people typing codes ({@link CREDENTIAL_RATE_LIMIT}).
 */
export const EMAIL_LINK_POLL_RATE_LIMIT = 300

const router = new Hono<AppEnv>()

type FlowContext = Context<AppEnv & { Variables: TenantVariables }>

const limited = (name: string, limit = CREDENTIAL_RATE_LIMIT) =>
  rateLimit({ name, limit, window: '1m', key: byIp })

const codeAttemptLimit = limited('sign_in_first_factor_code')
const linkPollLimit = limited('sign_in_link_poll', EMAIL_LINK_POLL_RATE_LIMIT)

/** Apply `limit` to requests whose validated body names `strategy`, and to no others. */
function firstFactorLimit(
  strategy: FirstFactorAttemptRequest['strategy'],
  limit: MiddlewareHandler<AppEnv>
) {
  return createMiddleware<AppEnv, string, { out: { json: FirstFactorAttemptRequest } }>(
    (c, next) => (c.req.valid('json').strategy === strategy ? limit(c, next) : next())
  )
}

const attemptResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(FlowAttemptSchema) } },
})

const errors = {
  401: openapi.responses[401],
  422: openapi.responses[422],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const DELIVERY =
  ' When the step is `complete`, `session` carries the tokens: browsers (`x-tula-client: web`, ' +
  'the default) receive the refresh token as an httpOnly cookie, other clients in the body.'

const START =
  ' The response carries `attemptSecret`, once: send it as the `x-tula-attempt` header on ' +
  'every later call for this attempt. A browser attempt (`x-tula-client: web`) is refused ' +
  'with `request.origin_not_allowed` from an origin the environment does not allow.'

const BOUND =
  ' Requires the attempt’s secret in `x-tula-attempt`; without it the attempt answers ' +
  '`flow.not_found`.'

/**
 * The requesting device, and whether its origin may set this environment's cookies. The one
 * place a flow route's context is built, so every route applies the same origin rule.
 */
async function clientContext(
  c: FlowContext,
  start: z.infer<typeof ClientHeaderSchema> = {}
): Promise<Flows.ClientContext> {
  return {
    client: start[CLIENT_HEADER] ?? 'web',
    profile: start[SESSION_PROFILE_HEADER],
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress: clientIp(c, c.get('deps').config.trustProxy),
    originAllowed: await originMayUseCookies(c),
    origin: c.req.header('origin') ?? null,
  }
}

/**
 * Send a flow result. On `complete`, a browser's refresh token is moved out of the body into
 * its cookie, and a `stateful` session's token goes only into the session cookie; every flow
 * response is uncacheable.
 */
function respond(c: FlowContext, result: Flows.FlowResult): Response {
  c.header('Cache-Control', 'no-store')
  if (!result.tokens) {
    return c.json(FlowAttemptSchema.parse(result.attempt))
  }
  const { refreshToken, sessionToken, cookieMaxAge, ...session } = result.tokens
  const [config, { environmentId }] = [c.get('deps').config, c.get('tenant')]
  if (sessionToken && cookieMaxAge) {
    // A stateful session (always a browser's): its one token goes into the cookie and nothing
    // of it into the body, which holds the session id only.
    setSessionCookie(c, config, environmentId, sessionToken, cookieMaxAge)
    return c.json(FlowAttemptSchema.parse({ ...result.attempt, session }))
  }
  if (result.client === 'web' && refreshToken && cookieMaxAge) {
    setRefreshCookie(c, config, environmentId, refreshToken, cookieMaxAge)
    return c.json(FlowAttemptSchema.parse({ ...result.attempt, session }))
  }
  return c.json(
    FlowAttemptSchema.parse({ ...result.attempt, session: { ...session, refreshToken } })
  )
}

router.post(
  '/sign-ups',
  describeRoute({
    operationId: 'startSignUp',
    tags: ['Flows'],
    summary: 'Start a sign-up',
    description:
      'Checks the email and password and emails a 6-digit code. The account is created when ' +
      'the code is verified. The response is the same whether or not the address already has ' +
      'an account. `password` may be left out only where the environment says ' +
      '`signUp.password: optional`; the account then has no password and signs in by email. Send `x-tula-client` (`web`, `ios`, `android` or `server`) to choose how ' +
      'tokens are delivered when the flow completes.' +
      START,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The attempt, waiting on email verification.'),
      // `auth.method_disabled`: the environment has switched password sign-in off.
      // `request.origin_not_allowed`: a browser attempt from an origin that is not allowed.
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('sign_up', SIGN_UP_RATE_LIMIT),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  validator('json', SignUpRequestSchema, validationHook),
  async (c) => {
    const context = await clientContext(c, c.req.valid('header'))
    return respond(
      c,
      await Flows.signUp(c.get('deps'), c.get('tenant'), c.req.valid('json'), context)
    )
  }
)

router.post(
  '/sign-ins',
  describeRoute({
    operationId: 'startSignIn',
    tags: ['Flows'],
    summary: 'Start a sign-in',
    description:
      'Answers with the first factors the environment offers: `needs_password` when the ' +
      'password is its only sign-in method, `needs_first_factor` with the enabled strategies ' +
      'otherwise. The answer depends only on the environment’s settings, never on the ' +
      'identifier: it is the same whether or not the address has an account. ' +
      'Send `x-tula-client` to choose how tokens are delivered when the flow completes.' +
      START,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The attempt, waiting on a first factor.'),
      // `auth.method_disabled`: the environment has switched password sign-in off.
      // `request.origin_not_allowed`: a browser attempt from an origin that is not allowed.
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('sign_in'),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  validator('json', SignInStartRequestSchema, validationHook),
  async (c) => {
    const context = await clientContext(c, c.req.valid('header'))
    return respond(
      c,
      await Flows.signIn(c.get('deps'), c.get('tenant'), c.req.valid('json'), context)
    )
  }
)

router.post(
  '/sign-ins/:attemptId/password',
  describeRoute({
    operationId: 'submitSignInPassword',
    tags: ['Flows'],
    summary: 'Submit the password',
    description:
      'For an attempt on `needs_password`, or on `needs_first_factor` with `password` among ' +
      'its strategies. Completes the sign-in, or moves it to `needs_email_verification` when ' +
      'the user’s email is not verified yet, or to `needs_second_factor` (no tokens) when the ' +
      'user has a second factor. Every failure is the same `auth.invalid_credentials`. A ' +
      'password that is right and older than the environment’s `password.expiryDays` allows ' +
      'does not sign in: once everything else the sign-in needs is proven (the second factor ' +
      'included) the attempt waits on `needs_new_password` with `reason: "expired"` and no ' +
      'tokens, for `…/new-password`. Only a right password is ever answered that way.' +
      BOUND +
      DELIVERY,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The next step.'),
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('sign_in_password'),
  publishableKey(),
  validator('param', AttemptIdParamSchema, validationHook),
  validator('header', AttemptHeaderSchema, validationHook),
  validator('json', PasswordAttemptRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.submitPassword(
        c.get('deps'),
        c.get('tenant'),
        { id: c.req.valid('param').attemptId, secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER] },
        c.req.valid('json').password,
        await clientContext(c)
      )
    )
)

router.post(
  '/sign-ins/:attemptId/new-password',
  describeRoute({
    operationId: 'submitSignInNewPassword',
    tags: ['Flows'],
    summary: 'Replace an expired password',
    description:
      'For a sign-in on `needs_new_password` (`reason: "expired"`): the password it proved is ' +
      'older than the environment’s `password.expiryDays` allows. Stores the new password, ' +
      'ends every other session of the user and completes the sign-in. The new password must ' +
      'meet the policy and must not be one the user may not set again (`password.reused`): ' +
      'the expired password itself is always refused, whatever `password.history` says. A ' +
      'refused password leaves the attempt on the step, to be tried again with another. ' +
      'Answers `flow.invalid_step` when the account’s password was replaced some other way ' +
      'since the attempt proved it: start the sign-in again.' +
      BOUND +
      DELIVERY,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The completed attempt.'),
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('sign_in_new_password'),
  publishableKey(),
  validator('param', AttemptIdParamSchema, validationHook),
  validator('header', AttemptHeaderSchema, validationHook),
  validator('json', NewPasswordRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.replaceExpiredPassword(
        c.get('deps'),
        c.get('tenant'),
        { id: c.req.valid('param').attemptId, secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER] },
        c.req.valid('json').password,
        await clientContext(c)
      )
    )
)

router.post(
  '/sign-ins/:attemptId/first-factor/prepare',
  describeRoute({
    operationId: 'prepareSignInFirstFactor',
    tags: ['Flows'],
    summary: 'Email or text a sign-in code, or email a link',
    description:
      '`sms_code`, for a sign-in started with a phone number: texts a 6-digit code to the ' +
      'number when exactly one account has proven it within the last year, and sends nothing ' +
      'otherwise; the answer is the same either way, and whether the message could be sent ' +
      'is not reported. The number’s country must be one the environment sends to ' +
      '(`sms.country_not_allowed`). Limited as every text message is. ' +
      'For an attempt on `needs_first_factor` offering `email_code` or `email_link`: emails a ' +
      '6-digit code and, for `email_link`, a link to `redirectUrl`, which must be exactly one ' +
      'of the environment’s `urls.allowedRedirectUrls` (`request.redirect_not_allowed` ' +
      'otherwise). The answer is the same whether or not the address has an account. The link ' +
      'carries its token in the URL fragment and works only in the browser that asked: the ' +
      'response carries `linkBinding`, once, which that browser sends back with the link’s ' +
      'token to `sign-ins/link`. Calling it again sends a fresh email and retires the previous ' +
      'one. Limited to one email a minute and five an hour per address.' +
      BOUND,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The attempt, on `needs_first_factor` with `prepared`.'),
      400: {
        ...openapi.responses[400],
        description:
          'The redirect URL is not, exactly, one of the environment’s allowed redirect URLs ' +
          '(`request.redirect_not_allowed`), or the request could not be read.',
      },
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('sign_in_prepare', SIGN_UP_RATE_LIMIT),
  publishableKey(),
  validator('param', AttemptIdParamSchema, validationHook),
  validator('header', AttemptHeaderSchema, validationHook),
  validator('json', FirstFactorPrepareRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.prepareFirstFactor(
        c.get('deps'),
        c.get('tenant'),
        { id: c.req.valid('param').attemptId, secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER] },
        c.req.valid('json'),
        await clientContext(c)
      )
    )
)

router.post(
  '/sign-ins/:attemptId/first-factor/attempt',
  describeRoute({
    operationId: 'attemptSignInFirstFactor',
    tags: ['Flows'],
    summary: 'Prove an emailed or texted first factor',
    description:
      '`sms_code`: submits the texted code (five guesses, ten minutes; every try also counts ' +
      'against the identifier’s lockout). Every failure is `auth.invalid_credentials`. Where ' +
      'the environment requires two-step verification and the user has none, a texted code ' +
      'alone does not sign in (`mfa.enrolment_needs_other_sign_in`). ' +
      '`email_code`: submits the emailed code (five guesses, ten minutes; every try also ' +
      'counts against the identifier’s lockout, shared with password sign-in). `email_link`: ' +
      'asks whether the emailed link has been opened in the browser that asked for it; until ' +
      'then the answer is the unchanged step, and asking costs no guess (such requests have ' +
      'their own per-IP limit, apart from code attempts). On success the ' +
      'sign-in completes, or moves to `needs_second_factor` (no tokens) for a user who has a ' +
      'second factor. The email counts as verified.' +
      BOUND +
      DELIVERY,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The next step.'),
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      410: openapi.responses[410],
      ...errors,
    },
  }),
  publishableKey(),
  validator('param', AttemptIdParamSchema, validationHook),
  validator('header', AttemptHeaderSchema, validationHook),
  validator('json', FirstFactorAttemptRequestSchema, validationHook),
  // After the body is validated, because which limit applies depends on its `strategy`, and
  // only a validated one can be trusted to choose. (Requests that fail validation, or carry no
  // valid key, are bounded by the per-IP limit on every client route.) A code is a guess at a
  // secret and keeps the credential limit; a poll for a link has its own, larger bucket.
  firstFactorLimit('email_code', codeAttemptLimit),
  firstFactorLimit('sms_code', codeAttemptLimit),
  firstFactorLimit('email_link', linkPollLimit),
  async (c) =>
    respond(
      c,
      await Flows.attemptFirstFactor(
        c.get('deps'),
        c.get('tenant'),
        { id: c.req.valid('param').attemptId, secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER] },
        c.req.valid('json'),
        await clientContext(c)
      )
    )
)

router.post(
  '/sign-ins/link',
  describeRoute({
    operationId: 'verifySignInLink',
    tags: ['Flows'],
    summary: 'Accept an emailed sign-in link',
    description:
      'Called by the page an emailed link leads to, with the token and attempt id from the ' +
      'link’s fragment and the `linkBinding` this browser was given when it asked for the ' +
      'link. A link opened in any other browser has no binding: it answers ' +
      '`verification.different_browser` and uses nothing up. A dead link answers ' +
      '`verification.expired`. On success the answer is `verified` and **carries no tokens**: ' +
      'the client that started the sign-in completes it with `first-factor/attempt`.',
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: {
        description: 'The link was accepted.',
        content: { 'application/json': { schema: resolver(EmailLinkResultSchema) } },
      },
      403: openapi.responses[403],
      409: openapi.responses[409],
      410: openapi.responses[410],
      ...errors,
    },
  }),
  limited('sign_in_link'),
  publishableKey(),
  validator('json', EmailLinkRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      EmailLinkResultSchema.parse(
        await Flows.verifyEmailLink(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('json'),
          await clientContext(c)
        )
      )
    )
  }
)

router.post(
  '/sign-ins/passkey',
  describeRoute({
    operationId: 'startPasskeySignIn',
    tags: ['Flows'],
    summary: 'Start signing in with a passkey',
    description:
      'A sign-in with no identifier: the answer is an attempt of its own on ' +
      '`needs_first_factor` (`strategies: ["passkey"]`) and the options for ' +
      '`navigator.credentials.get()`. The options carry no `allowCredentials` (the credential ' +
      'is discoverable), so the answer is the same for every caller and says nothing about ' +
      'any account. The challenge works once and for five minutes. Passkeys must be on for ' +
      'the environment (`auth.method_disabled` otherwise), and the request’s `Origin` must be ' +
      'one the environment allows and belong to its `passkeys.rpId` ' +
      '(`request.origin_not_allowed`).' +
      START,
    security: openapi.security.client,
    responses: {
      200: {
        description: 'The attempt and the request options.',
        content: { 'application/json': { schema: resolver(PasskeySignInStartSchema) } },
      },
      400: openapi.responses[400],
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('sign_in_passkey_start'),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  async (c) => {
    const context = await clientContext(c, c.req.valid('header'))
    const { client: _client, ...started } = await Flows.startPasskeySignIn(
      c.get('deps'),
      c.get('tenant'),
      context
    )
    c.header('Cache-Control', 'no-store')
    return c.json(PasskeySignInStartSchema.parse(started))
  }
)

router.post(
  '/sign-ins/:attemptId/passkey',
  describeRoute({
    operationId: 'submitSignInPasskey',
    tags: ['Flows'],
    summary: 'Sign in with a passkey',
    description:
      'Submits the assertion `navigator.credentials.get()` returned for the options of ' +
      '`POST /v1/client/sign-ins/passkey` and completes the sign-in. **A passkey satisfies ' +
      'two-step verification on its own**: this step never answers `needs_second_factor`. ' +
      'Every failure (unknown credential, wrong signature, another origin, a used or expired ' +
      'challenge, no user verification, a signature counter that went backwards) is the same ' +
      '`auth.invalid_credentials`, and the challenge is used up by the first assertion ' +
      'presented: start again for another try.' +
      BOUND +
      DELIVERY,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The completed attempt, or `needs_email_verification`.'),
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('sign_in_passkey'),
  publishableKey(),
  validator('param', AttemptIdParamSchema, validationHook),
  validator('header', AttemptHeaderSchema, validationHook),
  validator('json', PasskeySignInRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.submitPasskey(
        c.get('deps'),
        c.get('tenant'),
        {
          id: c.req.valid('param').attemptId,
          secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER],
        },
        c.req.valid('json').credential,
        await clientContext(c)
      )
    )
)

router.post(
  '/sign-ins/oauth',
  describeRoute({
    operationId: 'startOAuthSignIn',
    tags: ['Flows'],
    summary: 'Start signing in with an OAuth provider',
    description:
      '"Continue with Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X or Facebook": a sign-in that creates the account when the ' +
      'provider’s verified address has none (X and Facebook give no address: a first sign-in with one creates an account without an email address, `email: null`). The provider must be enabled for the environment ' +
      '(`auth.method_disabled` otherwise) and `redirectUrl`, the page of the app the user ' +
      'comes back to, must be exactly one of `urls.allowedRedirectUrls` ' +
      '(`request.redirect_not_allowed`). The answer carries `authorizationUrl` (send the ' +
      'browser there) and `binding`, once: keep it for the tab and send it back with the ' +
      'ticket that page receives. The provider returns to this API, which redirects to ' +
      '`redirectUrl` with `#tula_ticket=…&tula_attempt=…` (or `#tula_error=<code>`). No token ' +
      'is ever put in a URL.' +
      START,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: {
        description: 'The attempt, the provider’s URL and the binding.',
        content: { 'application/json': { schema: resolver(OAuthStartSchema) } },
      },
      400: openapi.responses[400],
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('sign_in_oauth'),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  validator('json', OAuthStartRequestSchema, validationHook),
  async (c) => {
    const context = await clientContext(c, c.req.valid('header'))
    const { client: _client, ...started } = await Flows.startOAuth(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      context
    )
    c.header('Cache-Control', 'no-store')
    return c.json(OAuthStartSchema.parse(started))
  }
)

router.post(
  '/sign-ins/oauth/exchange',
  describeRoute({
    operationId: 'exchangeOAuthTicket',
    tags: ['Flows'],
    summary: 'Exchange an OAuth ticket for the next step',
    description:
      'Called by the app’s page after the provider returned, with the ticket and attempt id ' +
      'from the URL fragment and the `binding` this browser was given at the start. The ' +
      'ticket works once, for 60 seconds. Without the matching binding the answer is ' +
      '`oauth.different_browser` and nothing is completed or used up. Otherwise the sign-in ' +
      'continues as after any first factor: `complete`, or `needs_second_factor` / ' +
      '`needs_factor_enrolment` (no tokens), in which case the response carries a new ' +
      '`attemptSecret` for the steps that follow. `oauth.account_exists`: the address ' +
      'belongs to an account this provider cannot be connected to automatically.' +
      DELIVERY,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The next step.'),
      403: openapi.responses[403],
      409: openapi.responses[409],
      410: openapi.responses[410],
      ...errors,
    },
  }),
  limited('sign_in_oauth_exchange'),
  publishableKey(),
  validator('json', OAuthExchangeRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.exchangeOAuth(
        c.get('deps'),
        c.get('tenant'),
        c.req.valid('json'),
        await clientContext(c)
      )
    )
)

for (const [kind, path, tag] of [
  ['sign_up', '/sign-ups', 'SignUp'],
  ['sign_in', '/sign-ins', 'SignIn'],
] as const satisfies readonly (readonly [Exclude<FlowKind, 'password_reset'>, string, string])[]) {
  router.post(
    `${path}/:attemptId/verify-email`,
    describeRoute({
      operationId: `verify${tag}Email`,
      tags: ['Flows'],
      summary: 'Submit the emailed code',
      description:
        'Verifies the 6-digit code for an attempt waiting on `needs_email_verification` and ' +
        'completes it (a sign-in of a user with a second factor moves to ' +
        '`needs_second_factor` instead). A code allows five guesses and lasts ten minutes.' +
        BOUND +
        DELIVERY,
      security: openapi.security.client,
      responses: {
        413: openapi.responses[413],
        200: attemptResponse('The completed attempt.'),
        403: openapi.responses[403],
        404: openapi.responses[404],
        409: openapi.responses[409],
        410: openapi.responses[410],
        ...errors,
      },
    }),
    limited(`${kind}_verify`),
    publishableKey(),
    validator('param', AttemptIdParamSchema, validationHook),
    validator('header', AttemptHeaderSchema, validationHook),
    validator('json', VerifyEmailRequestSchema, validationHook),
    async (c) =>
      respond(
        c,
        await Flows.verifyEmail(
          c.get('deps'),
          c.get('tenant'),
          kind,
          {
            id: c.req.valid('param').attemptId,
            secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER],
          },
          c.req.valid('json').code,
          await clientContext(c)
        )
      )
  )
}

router.post(
  '/password-resets',
  describeRoute({
    operationId: 'startPasswordReset',
    tags: ['Flows'],
    summary: 'Start a password reset',
    description:
      'Emails a 6-digit code to the address. The response is the same whether or not the ' +
      'address has an account. Send `x-tula-client` to choose how tokens are delivered when ' +
      'the reset completes.' +
      START,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The attempt, waiting on the code and a new password.'),
      // `auth.method_disabled`: the environment has switched password sign-in off.
      // `request.origin_not_allowed`: a browser attempt from an origin that is not allowed.
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('password_reset', SIGN_UP_RATE_LIMIT),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  validator('json', PasswordResetStartRequestSchema, validationHook),
  async (c) => {
    const context = await clientContext(c, c.req.valid('header'))
    return respond(
      c,
      await Flows.startPasswordReset(c.get('deps'), c.get('tenant'), c.req.valid('json'), context)
    )
  }
)

router.post(
  '/password-resets/:attemptId/password',
  describeRoute({
    operationId: 'submitPasswordReset',
    tags: ['Flows'],
    summary: 'Submit the emailed code and a new password',
    description:
      'Checks the 6-digit code, stores the new password, ends every existing session of the ' +
      'user and signs them in. A user with a second factor is not signed in: the attempt ' +
      'moves to `needs_second_factor` with the new password already stored. A user who had no ' +
      'password gets their first one. A code allows five guesses and lasts ten minutes; a new ' +
      'password the policy rejects uses one guess but not the code.' +
      BOUND +
      DELIVERY,
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The completed attempt.'),
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      410: openapi.responses[410],
      ...errors,
    },
  }),
  limited('password_reset_submit'),
  publishableKey(),
  validator('param', AttemptIdParamSchema, validationHook),
  validator('header', AttemptHeaderSchema, validationHook),
  validator('json', PasswordResetRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.resetPassword(
        c.get('deps'),
        c.get('tenant'),
        { id: c.req.valid('param').attemptId, secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER] },
        c.req.valid('json'),
        await clientContext(c)
      )
    )
)

for (const [kind, path, tag] of [
  ['sign_up', '/sign-ups', 'SignUp'],
  ['sign_in', '/sign-ins', 'SignIn'],
  ['password_reset', '/password-resets', 'PasswordReset'],
] as const satisfies readonly (readonly [FlowKind, string, string])[]) {
  router.post(
    `${path}/:attemptId/resend-code`,
    describeRoute({
      operationId: `resend${tag}Code`,
      tags: ['Flows'],
      summary: 'Resend the email code',
      description:
        'Emails a fresh code and retires the previous one. Limited to one email a minute and ' +
        'five an hour per address.' +
        BOUND,
      security: openapi.security.client,
      responses: {
        200: attemptResponse('The attempt, still waiting on the emailed code.'),
        404: openapi.responses[404],
        409: openapi.responses[409],
        // `auth.method_disabled`: the environment has switched password sign-in off.
        // `request.origin_not_allowed`: a browser attempt from an origin that is not allowed.
        403: openapi.responses[403],
        ...errors,
      },
    }),
    limited(`${kind}_resend`, SIGN_UP_RATE_LIMIT),
    publishableKey(),
    validator('param', AttemptIdParamSchema, validationHook),
    validator('header', AttemptHeaderSchema, validationHook),
    async (c) =>
      respond(
        c,
        await Flows.resendCode(
          c.get('deps'),
          c.get('tenant'),
          kind,
          {
            id: c.req.valid('param').attemptId,
            secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER],
          },
          await clientContext(c)
        )
      )
  )
}

for (const [kind, path, tag] of [
  ['sign_in', '/sign-ins', 'SignIn'],
  ['password_reset', '/password-resets', 'PasswordReset'],
] as const satisfies readonly (readonly [Exclude<FlowKind, 'sign_up'>, string, string])[]) {
  router.post(
    `${path}/:attemptId/second-factor`,
    describeRoute({
      operationId: `submit${tag}SecondFactor`,
      tags: ['Flows'],
      summary: 'Submit a second factor',
      description:
        'Proves one of the `options` of an attempt waiting on `needs_second_factor` and ' +
        'completes it: `totp` with the 6-digit code an authenticator app shows now (the ' +
        'current 30-second step or one either side; a code is accepted once), or ' +
        '`backup_code` with an unused backup code (case, spaces and dashes are ignored; it is ' +
        'spent, and `backupCodesRemaining` says how many are left). A wrong code is ' +
        '`mfa.invalid_code`; wrong codes back off per user across both methods (429 with ' +
        '`Retry-After`). No tokens are returned before this step succeeds.' +
        BOUND +
        DELIVERY,
      security: openapi.security.client,
      responses: {
        413: openapi.responses[413],
        200: attemptResponse('The completed attempt.'),
        403: openapi.responses[403],
        404: openapi.responses[404],
        409: openapi.responses[409],
        ...errors,
      },
    }),
    limited(`${kind}_second_factor`),
    publishableKey(),
    validator('param', AttemptIdParamSchema, validationHook),
    validator('header', AttemptHeaderSchema, validationHook),
    validator('json', SecondFactorRequestSchema, validationHook),
    async (c) => {
      const proof = c.req.valid('json')
      return respond(
        c,
        await Flows.submitSecondFactor(
          c.get('deps'),
          c.get('tenant'),
          kind,
          {
            id: c.req.valid('param').attemptId,
            secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER],
          },
          {
            method: proof.method,
            response: proof.method === 'passkey' ? proof.credential : proof.code,
          },
          await clientContext(c)
        )
      )
    }
  )

  router.post(
    `${path}/:attemptId/second-factor/passkey/options`,
    describeRoute({
      operationId: `get${tag}SecondFactorPasskeyOptions`,
      tags: ['Flows'],
      summary: 'Get the options for a passkey second factor',
      description:
        'For an attempt waiting on `needs_second_factor` whose `options` include `passkey`: ' +
        'the options for `navigator.credentials.get()`, naming the user’s own passkeys. The ' +
        'challenge works once and for five minutes; asking again replaces it. Submit the ' +
        'assertion to `…/second-factor` with `method: "passkey"`. The request’s `Origin` must ' +
        'be one the environment allows and belong to its `passkeys.rpId`.' +
        BOUND,
      security: openapi.security.client,
      responses: {
        200: {
          description: 'The request options.',
          content: { 'application/json': { schema: resolver(PasskeyRequestOptionsSchema) } },
        },
        403: openapi.responses[403],
        404: openapi.responses[404],
        409: openapi.responses[409],
        ...errors,
      },
    }),
    limited(`${kind}_second_factor_passkey_options`),
    publishableKey(),
    validator('param', AttemptIdParamSchema, validationHook),
    validator('header', AttemptHeaderSchema, validationHook),
    async (c) => {
      c.header('Cache-Control', 'no-store')
      return c.json(
        PasskeyRequestOptionsSchema.parse(
          await Flows.secondFactorPasskeyOptions(
            c.get('deps'),
            c.get('tenant'),
            kind,
            {
              id: c.req.valid('param').attemptId,
              secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER],
            },
            await clientContext(c)
          )
        )
      )
    }
  )
}

for (const [kind, path, tag] of [
  ['sign_up', '/sign-ups', 'SignUp'],
  ['sign_in', '/sign-ins', 'SignIn'],
  ['password_reset', '/password-resets', 'PasswordReset'],
] as const satisfies readonly (readonly [FlowKind, string, string])[]) {
  router.post(
    `${path}/:attemptId/factor-enrolment/totp`,
    describeRoute({
      operationId: `start${tag}TotpEnrolment`,
      tags: ['Flows'],
      summary: 'Start enrolling an authenticator app inside an attempt',
      description:
        'For an attempt waiting on `needs_factor_enrolment` (the environment requires a second ' +
        'factor and the user has none): creates a pending authenticator and returns its secret ' +
        '**once**, as Base32 and as an `otpauth://` URI. Calling it again replaces the pending ' +
        'secret.' +
        BOUND,
      security: openapi.security.client,
      responses: {
        200: {
          description: 'The secret and its URI.',
          content: { 'application/json': { schema: resolver(TotpEnrolmentSchema) } },
        },
        403: openapi.responses[403],
        404: openapi.responses[404],
        409: openapi.responses[409],
        ...errors,
      },
    }),
    limited(`${kind}_enrolment_start`, SIGN_UP_RATE_LIMIT),
    publishableKey(),
    validator('param', AttemptIdParamSchema, validationHook),
    validator('header', AttemptHeaderSchema, validationHook),
    async (c) => {
      c.header('Cache-Control', 'no-store')
      return c.json(
        TotpEnrolmentSchema.parse(
          await Flows.startFactorEnrolment(
            c.get('deps'),
            c.get('tenant'),
            kind,
            {
              id: c.req.valid('param').attemptId,
              secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER],
            },
            await clientContext(c)
          )
        )
      )
    }
  )

  router.post(
    `${path}/:attemptId/factor-enrolment/totp/confirm`,
    describeRoute({
      operationId: `confirm${tag}TotpEnrolment`,
      tags: ['Flows'],
      summary: 'Confirm the authenticator app and complete the attempt',
      description:
        'Confirms the pending authenticator with the 6-digit code it shows and completes the ' +
        'attempt. The response carries the session and `backupCodes`: ten backup codes, ' +
        '**once**. A wrong code is `mfa.invalid_code` and counts against the user’s ' +
        'second-factor lockout; after ten minutes it is `mfa.enrolment_expired` (410).' +
        BOUND +
        DELIVERY,
      security: openapi.security.client,
      responses: {
        413: openapi.responses[413],
        200: attemptResponse('The completed attempt, with the backup codes.'),
        403: openapi.responses[403],
        404: openapi.responses[404],
        409: openapi.responses[409],
        410: openapi.responses[410],
        ...errors,
      },
    }),
    limited(`${kind}_enrolment_confirm`),
    publishableKey(),
    validator('param', AttemptIdParamSchema, validationHook),
    validator('header', AttemptHeaderSchema, validationHook),
    validator('json', TotpConfirmRequestSchema, validationHook),
    async (c) =>
      respond(
        c,
        await Flows.confirmFactorEnrolment(
          c.get('deps'),
          c.get('tenant'),
          kind,
          {
            id: c.req.valid('param').attemptId,
            secret: c.req.valid('header')[FLOW_ATTEMPT_HEADER],
          },
          c.req.valid('json').code,
          await clientContext(c)
        )
      )
  )
}

export default router
