import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { requireRecentAuth } from '~/middleware/recent-auth'
import { sessionAuth } from '~/middleware/session-auth'
import * as EmailAddress from '~/modules/email-address/service'
import * as openapi from '~/openapi'
import {
  CurrentUserSchema,
  EmailAddressRequestSchema,
  EmailAddressVerifyRequestSchema,
  EmailCodeSentSchema,
} from './schema'

/** Requests per minute from one IP to each route that gives a user an email address. */
export const EMAIL_ADDRESS_RATE_LIMIT = 10

// Mounted at `/v1`: an email address for the signed-in user who has none (ADR 0059).
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const limited = (name: string) =>
  rateLimit({ name, limit: EMAIL_ADDRESS_RATE_LIMIT, window: '1m', key: byIp })

const errors = {
  401: openapi.responses[401],
  403: openapi.responses[403],
  404: openapi.responses[404],
  409: openapi.responses[409],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const STEP_UP =
  ' Needs a recent authentication: when the session’s last proof is older than ten minutes ' +
  '(or, for a user with two-step verification, did not include a second factor) it answers ' +
  '`auth.step_up_required` (403) with `params.methods`. An account with no address has no ' +
  'password and no emailed code to step up with: `params.methods` lists a passkey or a ' +
  'second factor when the account has one and is empty otherwise, and the user then signs ' +
  'in again with their provider and repeats the request within ten minutes.'

router.post(
  '/client/me/email',
  describeRoute({
    operationId: 'requestEmailAddressCode',
    tags: ['Email address'],
    summary: 'Email a code to an address to add to my account',
    description:
      'For a signed-in user whose account has **no** email address (one made by a first ' +
      'sign-in with X or Facebook). Sends a 6-digit code to the address, which becomes the ' +
      '**pending** address (replacing an earlier pending one); nothing is stored on the ' +
      'account until `POST /v1/client/me/email/verify`. An account that already has an ' +
      'address answers `email.already_set` (409): changing an address is not this route. ' +
      'What is not an address is `email.invalid` (422). **An address that belongs to ' +
      'another account is answered exactly like a free one**: the same body, the same ' +
      'limits. That account’s owner is emailed a notice with no code, and no code confirms ' +
      'the address. Codes are limited to one a minute and five an hour per user, and five ' +
      'an hour per address (`rate_limited`). The code works for ten minutes and for five ' +
      'guesses.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'The request was taken.', content: json(EmailCodeSentSchema) },
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('email_address_request'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('json', EmailAddressRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      EmailCodeSentSchema.parse(
        await EmailAddress.request(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          c.req.valid('json')
        )
      )
    )
  }
)

router.post(
  '/client/me/email/verify',
  describeRoute({
    operationId: 'verifyEmailAddress',
    tags: ['Email address'],
    summary: 'Confirm the address with its code',
    description:
      'Checks the code emailed to the pending address and, when it is right, stores the ' +
      'address on the account as verified and returns the user. From then on the account ' +
      'is like any other: it can sign in by emailed code where that is on, set a password ' +
      'by a reset, and is sent security notices. A wrong code is ' +
      '`verification.invalid_code` (422) and counts against the code’s five guesses and the ' +
      'user’s lockout; with nothing pending, or a code that expired, was used or was ' +
      'replaced by a newer one, `verification.expired` (410). The same answer, with the ' +
      'code spent, when another account took the address after the code was sent. An ' +
      'account that already has an address answers `email.already_set` (409).' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'The user, with the address.', content: json(CurrentUserSchema) },
      410: openapi.responses[410],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('email_address_verify'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('json', EmailAddressVerifyRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      CurrentUserSchema.parse(
        await EmailAddress.verify(
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

export default router
