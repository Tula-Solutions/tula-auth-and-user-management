import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { clientIp, ipBucket } from '~/lib/client-ip'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { requireRecentAuth } from '~/middleware/recent-auth'
import { sessionAuth } from '~/middleware/session-auth'
import * as Phone from '~/modules/phone/service'
import * as openapi from '~/openapi'
import {
  CurrentUserSchema,
  PhoneCodeSentSchema,
  PhoneNumberRequestSchema,
  PhoneNumberVerifyRequestSchema,
} from './schema'

/** Requests per minute from one IP to each route that changes a user's phone number. */
export const PHONE_RATE_LIMIT = 10

// Mounted at `/v1`: the signed-in user's phone number (ADR 0037).
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const limited = (name: string) =>
  rateLimit({ name, limit: PHONE_RATE_LIMIT, window: '1m', key: byIp })

const errors = {
  401: openapi.responses[401],
  403: openapi.responses[403],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const STEP_UP =
  ' Needs a recent authentication: when the session’s last proof is older than ten minutes ' +
  '(or, for a user with two-step verification, did not include a second factor) it answers ' +
  '`auth.step_up_required` (403) with `params.methods`; call `POST /v1/client/sessions/step-up` ' +
  'and repeat the request with the access token it returns.'

router.post(
  '/client/me/phone',
  describeRoute({
    operationId: 'requestPhoneCode',
    tags: ['Phone'],
    summary: 'Text a code to a phone number',
    description:
      'Sends a 6-digit code to a number the signed-in user wants on their account. The ' +
      'number becomes the **pending** number (replacing an earlier pending one); the ' +
      'account’s own number is unchanged until `POST /v1/client/me/phone/verify`. The number ' +
      'is given in international form (`+14155550100`; spaces, hyphens and parentheses are ' +
      'ignored), otherwise `phone.invalid` (422). Where the environment has SMS off, or ' +
      'allows no country, it answers `sms.disabled` (403); a number whose country is not ' +
      'allowed, `sms.country_not_allowed` (422). Nothing is sent in either case. Codes are ' +
      'limited to one a minute and five an hour per user and per number (`rate_limited`). ' +
      'A message the server could not send is `sms.unavailable` (503), and an earlier code ' +
      'then keeps working. The code works for ten minutes and for five guesses.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'The code was sent.', content: json(PhoneCodeSentSchema) },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('phone_code_request'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('json', PhoneNumberRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      PhoneCodeSentSchema.parse(
        await Phone.request(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('json'),
          // The address the per-IP limits count by: sends are limited per address too.
          { address: ipBucket(clientIp(c, c.get('deps').config.trustProxy)) }
        )
      )
    )
  }
)

router.post(
  '/client/me/phone/verify',
  describeRoute({
    operationId: 'verifyPhoneNumber',
    tags: ['Phone'],
    summary: 'Confirm a phone number with its code',
    description:
      'Checks the code texted to the pending number and, when it is right, makes that number ' +
      'the account’s (replacing the one it had) and returns the user. A wrong code is ' +
      '`verification.invalid_code` (422) and counts against the code’s five guesses and the ' +
      'user’s lockout; with nothing pending, or a code that expired, was used or was replaced ' +
      'by a newer one, `verification.expired` (410). A code is honoured only while the ' +
      'environment still allows a message to that number: `sms.disabled` (403) or ' +
      '`sms.country_not_allowed` (422) otherwise, with nothing counted.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'The user, with the number.', content: json(CurrentUserSchema) },
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('phone_code_verify'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('json', PhoneNumberVerifyRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      CurrentUserSchema.parse(
        await Phone.verify(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('json'),
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/client/me/phone',
  describeRoute({
    operationId: 'removePhoneNumber',
    tags: ['Phone'],
    summary: 'Remove my phone number',
    description:
      'Takes the phone number off the signed-in user’s account. Succeeds when there is none. ' +
      'A number that is only pending is not affected: it is not the account’s, and its code ' +
      'expires by itself.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      204: { description: 'The account has no phone number.' },
      ...errors,
    },
  }),
  limited('phone_remove'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  async (c) => {
    await Phone.remove(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      userActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
