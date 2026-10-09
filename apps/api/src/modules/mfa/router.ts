import { CAN_STILL_SIGN_IN_HEADER } from '@tula/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor, userActor } from '~/lib/actor'
import { clientIp, ipBucket } from '~/lib/client-ip'
import { publishableKey } from '~/middleware/publishable-key'
import { adminRateLimit, byIp, rateLimit } from '~/middleware/rate-limit'
import { requireRecentAuth } from '~/middleware/recent-auth'
import { secretKey } from '~/middleware/secret-key'
import { sessionAuth } from '~/middleware/session-auth'
import * as Mfa from '~/modules/mfa/service'
import { UserIdParamSchema } from '~/modules/user/schema'
import * as openapi from '~/openapi'
import {
  BackupCodesSchema,
  FactorsSchema,
  SmsFactorCodeSchema,
  SmsFactorConfirmRequestSchema,
  TotpConfirmRequestSchema,
  TotpEnrolmentSchema,
} from './schema'

/**
 * Requests per minute from one IP to each route that changes a user's second factor or checks
 * a code. The service adds the per-user lockout on every code it checks.
 */
export const MFA_RATE_LIMIT = 10

// Mounted at `/v1`: this module serves the signed-in user's routes and the admin reset.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const limited = (name: string) =>
  rateLimit({ name, limit: MFA_RATE_LIMIT, window: '1m', key: byIp })

const errors = {
  401: openapi.responses[401],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const STEP_UP =
  ' Needs a recent authentication: when the session’s last proof is older than ten minutes ' +
  '(or, for a user with two-step verification, did not include the second factor) it answers ' +
  '`auth.step_up_required` (403) with `params.methods`; call `POST /v1/client/sessions/step-up` ' +
  'and repeat the request with the access token it returns.'

router.get(
  '/client/me/factors',
  describeRoute({
    operationId: 'getMyFactors',
    tags: ['MFA'],
    summary: 'Get my second factors',
    description:
      'Whether the signed-in user has an authenticator app confirmed, since when, and how many ' +
      'backup codes are unused; and `sms`: whether a texted code is enrolled as their second ' +
      'factor, whether it is the one they are asked for (`inUse`: never beside an ' +
      'authenticator app or a passkey) and whether they could enrol it now. Never a secret, ' +
      'and never the phone number.',
    security: openapi.security.session,
    responses: {
      200: { description: 'What is enrolled.', content: json(FactorsSchema) },
      ...errors,
    },
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      FactorsSchema.parse(await Mfa.status(c.get('deps'), c.get('tenant'), c.get('session').sub))
    )
  }
)

router.post(
  '/client/me/factors/totp',
  describeRoute({
    operationId: 'startTotpEnrolment',
    tags: ['MFA'],
    summary: 'Start enrolling an authenticator app',
    description:
      'Creates a pending authenticator (TOTP: RFC 6238, SHA-1, 6 digits, 30 seconds) and ' +
      'returns its secret **once**, as Base32 and as an `otpauth://` URI for a QR code. It ' +
      'counts for nothing until confirmed with a code, and lapses after ten minutes. Calling ' +
      'it again replaces the pending secret. Refused with `mfa.not_available` where the ' +
      'environment’s `mfa.policy` is `off`, and with `mfa.already_enabled` (409) for a user ' +
      'who already has one.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      200: { description: 'The secret and its URI.', content: json(TotpEnrolmentSchema) },
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('mfa_totp_start'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      TotpEnrolmentSchema.parse(
        await Mfa.startTotp(c.get('deps'), c.get('tenant'), c.get('session').sub)
      )
    )
  }
)

router.post(
  '/client/me/factors/totp/confirm',
  describeRoute({
    operationId: 'confirmTotpEnrolment',
    tags: ['MFA'],
    summary: 'Confirm the authenticator app',
    description:
      'Confirms the pending authenticator with the 6-digit code it shows, turning two-step ' +
      'verification on, and returns ten backup codes **once**. Every other session of the ' +
      'user ends; this one stays signed in. A wrong code is `mfa.invalid_code` and counts ' +
      'against the user’s second-factor lockout; with nothing pending, or after ten minutes, ' +
      'it is `mfa.enrolment_expired` (410).',
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'The backup codes.', content: json(BackupCodesSchema) },
      409: openapi.responses[409],
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('mfa_totp_confirm'),
  publishableKey(),
  sessionAuth(),
  validator('json', TotpConfirmRequestSchema, validationHook),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      BackupCodesSchema.parse(
        await Mfa.confirmTotp(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('json').code,
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/client/me/factors/totp',
  describeRoute({
    operationId: 'disableTotp',
    tags: ['MFA'],
    summary: 'Turn two-step verification off',
    description:
      'Removes the signed-in user’s authenticator and every backup code. Refused with ' +
      '`mfa.required_by_policy` where the environment’s `mfa.policy` is `required`, and with ' +
      '`mfa.not_enabled` (409) when there is nothing to turn off.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      204: { description: 'Two-step verification is off.' },
      403: openapi.responses[403],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('mfa_totp_disable'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  async (c) => {
    await Mfa.disableTotp(c.get('deps'), c.get('tenant'), c.get('session').sub, userActor(c))
    return c.body(null, 204)
  }
)

router.post(
  '/client/me/factors/sms',
  describeRoute({
    operationId: 'startSmsFactorEnrolment',
    tags: ['MFA'],
    summary: 'Start making a texted code my second factor',
    description:
      'Texts a 6-digit code to **the phone number on the account** (never one from the ' +
      'request) and returns the masked number. Confirm it with ' +
      '`POST /v1/client/me/factors/sms/confirm` from this session. The code works for ten ' +
      'minutes, five guesses, once; a new one replaces it. Refused with `mfa.not_available` ' +
      'where the environment’s `mfa.policy` is `off` or `mfa.smsCode` is not on, ' +
      '`mfa.phone_number_required` (409) for an account with no phone number, ' +
      '`mfa.already_enabled` (409), and `mfa.sms_not_allowed` (409) for a user who has an ' +
      'authenticator app or a passkey: a texted code is never a second factor beside a ' +
      'stronger one. A message that could not be sent is `sms.unavailable` (503).' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      200: { description: 'The code was texted.', content: json(SmsFactorCodeSchema) },
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('mfa_sms_start'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      SmsFactorCodeSchema.parse(
        await Mfa.startSms(
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
  '/client/me/factors/sms/confirm',
  describeRoute({
    operationId: 'confirmSmsFactorEnrolment',
    tags: ['MFA'],
    summary: 'Confirm the texted code as my second factor',
    description:
      'Confirms the texted code, making a texted code the user’s second factor, and returns ' +
      'what is now enrolled. Every other session of the user ends; this one stays signed in ' +
      'and has proven the factor (`sms` in `amr`, never `mfa`). There are no backup codes: ' +
      'someone who loses the number is reset by an administrator. A wrong code is ' +
      '`mfa.invalid_code` and counts against the user’s second-factor lockout; with nothing ' +
      'pending, after ten minutes, or when the account’s number changed meanwhile it is ' +
      '`mfa.enrolment_expired` (410).' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'What is enrolled.', content: json(FactorsSchema) },
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('mfa_sms_confirm'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('json', SmsFactorConfirmRequestSchema, validationHook),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      FactorsSchema.parse(
        await Mfa.confirmSms(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('json').code,
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/client/me/factors/sms',
  describeRoute({
    operationId: 'disableSmsFactor',
    tags: ['MFA'],
    summary: 'Stop using a texted code as my second factor',
    description:
      'A texted code is no longer the signed-in user’s second factor. The phone number stays ' +
      'on the account. Refused with `mfa.required_by_policy` where the environment’s ' +
      '`mfa.policy` is `required` and the texted code is the factor the user is held to, and ' +
      'with `mfa.not_enabled` (409) when there is nothing to turn off.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      204: { description: 'A texted code is no longer the second factor.' },
      403: openapi.responses[403],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('mfa_sms_disable'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  async (c) => {
    await Mfa.disableSms(c.get('deps'), c.get('tenant'), c.get('session').sub, userActor(c))
    return c.body(null, 204)
  }
)

router.post(
  '/client/me/factors/backup-codes',
  describeRoute({
    operationId: 'regenerateBackupCodes',
    tags: ['MFA'],
    summary: 'Make new backup codes',
    description:
      'Replaces the signed-in user’s backup codes with ten new ones and returns them **once**. ' +
      'The earlier ones stop working. `mfa.not_enabled` (409) without a confirmed authenticator.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      200: { description: 'The new backup codes.', content: json(BackupCodesSchema) },
      403: openapi.responses[403],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('mfa_backup_codes'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      BackupCodesSchema.parse(
        await Mfa.regenerateBackupCodes(
          c.get('deps'),
          c.get('tenant'),
          c.get('session').sub,
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/admin/users/:userId/factors',
  describeRoute({
    operationId: 'resetUserFactors',
    tags: ['MFA'],
    summary: 'Reset a user’s two-step verification',
    description:
      'Removes the user’s authenticator and backup codes and ends **every** session of the ' +
      'user. The recovery path for someone who lost both their authenticator and their backup ' +
      'codes; there is no emailed bypass. Under `mfa.policy: required` the user enrols again ' +
      'at their next sign-in. Succeeds, and still ends the sessions, for a user with nothing ' +
      'enrolled.\n\n' +
      '**The user’s passkeys are removed too, even one that was their only way to sign in.** ' +
      'The `x-tula-can-still-sign-in` response header says what that left: `true` when a ' +
      'method the environment accepts remains (a password, a verified address where the ' +
      'emailed code is on, an enabled provider), `false` when nothing does. An account left ' +
      'with `false` cannot sign in until you give it a way in: for example the user’s own ' +
      '“Forgot password” where the password method is on, or switching on a method they can ' +
      'use. The same boolean is recorded on the `user.passkey_removed` audit entry.',
    security: openapi.security.admin,
    responses: {
      204: {
        description: 'Two-step verification was reset.',
        headers: {
          [CAN_STILL_SIGN_IN_HEADER]: {
            description:
              'Whether the user can still sign in with what they have left (`true` or `false`).',
            schema: { type: 'string' as const, enum: ['true', 'false'] },
          },
        },
      },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  async (c) => {
    const { canStillSignIn } = await Mfa.reset(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').userId,
      adminActor(c)
    )
    // A header, because the route has always answered 204 with no body and clients check for
    // exactly that: the outcome is added without changing what they already rely on.
    c.header(CAN_STILL_SIGN_IN_HEADER, String(canStillSignIn))
    return c.body(null, 204)
  }
)

export default router
