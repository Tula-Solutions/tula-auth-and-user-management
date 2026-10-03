import type { FlowKind } from '@tula/contract'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { validationHook } from '~/handlers'
import { clientIp } from '~/lib/client-ip'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import * as Flows from '~/modules/flow/service'
import { setRefreshCookie } from '~/modules/session/cookies'
import * as openapi from '~/openapi'
import {
  AttemptIdParamSchema,
  CLIENT_HEADER,
  ClientHeaderSchema,
  FlowAttemptSchema,
  PasswordAttemptRequestSchema,
  PasswordResetRequestSchema,
  PasswordResetStartRequestSchema,
  SignInStartRequestSchema,
  SignUpRequestSchema,
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

const router = new Hono<AppEnv>()

type FlowContext = Context<AppEnv & { Variables: TenantVariables }>

const limited = (name: string, limit = CREDENTIAL_RATE_LIMIT) =>
  rateLimit({ name, limit, window: '1m', key: byIp })

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

function clientContext(c: FlowContext, client: Flows.ClientContext['client'] | undefined) {
  return {
    client: client ?? 'web',
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress: clientIp(c, c.get('deps').config.trustProxy),
  } satisfies Flows.ClientContext
}

/**
 * Send a flow result. On `complete`, a browser's refresh token is moved out of the body into
 * its cookie; every flow response is uncacheable.
 */
function respond(c: FlowContext, result: Flows.FlowResult): Response {
  c.header('Cache-Control', 'no-store')
  if (!result.tokens) {
    return c.json(FlowAttemptSchema.parse(result.attempt))
  }
  const { refreshToken, ...session } = result.tokens
  if (result.client === 'web' && refreshToken) {
    setRefreshCookie(c, c.get('deps').config, c.get('tenant').environmentId, refreshToken)
    return c.json(FlowAttemptSchema.parse({ ...result.attempt, session }))
  }
  return c.json(FlowAttemptSchema.parse({ ...result.attempt, session: result.tokens }))
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
      'an account. Send `x-tula-client` (`web`, `ios`, `android` or `server`) to choose how ' +
      'tokens are delivered when the flow completes.',
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The attempt, waiting on email verification.'),
      // `auth.method_disabled`: the environment has switched password sign-in off.
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('sign_up', SIGN_UP_RATE_LIMIT),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  validator('json', SignUpRequestSchema, validationHook),
  async (c) => {
    const context = clientContext(c, c.req.valid('header')[CLIENT_HEADER])
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
      'Always answers `needs_password`, whether or not the identifier belongs to an account. ' +
      'Send `x-tula-client` to choose how tokens are delivered when the flow completes.',
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The attempt, waiting on a password.'),
      // `auth.method_disabled`: the environment has switched password sign-in off.
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('sign_in'),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  validator('json', SignInStartRequestSchema, validationHook),
  async (c) => {
    const context = clientContext(c, c.req.valid('header')[CLIENT_HEADER])
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
      'Completes the sign-in, or moves it to `needs_email_verification` when the user’s email ' +
      'is not verified yet. Every failure is the same `auth.invalid_credentials`.' +
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
  validator('json', PasswordAttemptRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.submitPassword(
        c.get('deps'),
        c.get('tenant'),
        c.req.valid('param').attemptId,
        c.req.valid('json').password,
        clientContext(c, undefined)
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
        'completes it. A code allows five guesses and lasts ten minutes.' +
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
    validator('json', VerifyEmailRequestSchema, validationHook),
    async (c) =>
      respond(
        c,
        await Flows.verifyEmail(
          c.get('deps'),
          c.get('tenant'),
          kind,
          c.req.valid('param').attemptId,
          c.req.valid('json').code,
          clientContext(c, undefined)
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
      'the reset completes.',
    security: openapi.security.client,
    responses: {
      413: openapi.responses[413],
      200: attemptResponse('The attempt, waiting on the code and a new password.'),
      // `auth.method_disabled`: the environment has switched password sign-in off.
      403: openapi.responses[403],
      ...errors,
    },
  }),
  limited('password_reset', SIGN_UP_RATE_LIMIT),
  publishableKey(),
  validator('header', ClientHeaderSchema, validationHook),
  validator('json', PasswordResetStartRequestSchema, validationHook),
  async (c) => {
    const context = clientContext(c, c.req.valid('header')[CLIENT_HEADER])
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
      'user and signs them in. A code allows five guesses and lasts ten minutes; a new ' +
      'password the policy rejects uses one guess but not the code.' +
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
  validator('json', PasswordResetRequestSchema, validationHook),
  async (c) =>
    respond(
      c,
      await Flows.resetPassword(
        c.get('deps'),
        c.get('tenant'),
        c.req.valid('param').attemptId,
        c.req.valid('json'),
        clientContext(c, undefined)
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
        'five an hour per address.',
      security: openapi.security.client,
      responses: {
        200: attemptResponse('The attempt, still waiting on the emailed code.'),
        404: openapi.responses[404],
        409: openapi.responses[409],
        // `auth.method_disabled`: the environment has switched password sign-in off.
        403: openapi.responses[403],
        ...errors,
      },
    }),
    limited(`${kind}_resend`, SIGN_UP_RATE_LIMIT),
    publishableKey(),
    validator('param', AttemptIdParamSchema, validationHook),
    async (c) =>
      respond(
        c,
        await Flows.resendCode(c.get('deps'), c.get('tenant'), kind, c.req.valid('param').attemptId)
      )
  )
}

export default router
