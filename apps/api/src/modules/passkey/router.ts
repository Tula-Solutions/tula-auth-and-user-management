import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'
import { requireRecentAuth } from '~/middleware/recent-auth'
import { sessionAuth } from '~/middleware/session-auth'
import * as Passkeys from '~/modules/passkey/service'
import * as openapi from '~/openapi'
import {
  PasskeyCreationOptionsSchema,
  PasskeyIdParamSchema,
  PasskeyListSchema,
  PasskeyRegisterRequestSchema,
  PasskeyRenameRequestSchema,
  PasskeySchema,
} from './schema'

/** Requests per minute from one IP to each route that changes a user's passkeys. */
export const PASSKEY_RATE_LIMIT = 10

// Mounted at `/v1`: the signed-in user's passkeys. Signing in with one is a flow route.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const limited = (name: string) =>
  rateLimit({ name, limit: PASSKEY_RATE_LIMIT, window: '1m', key: byIp })

const errors = {
  401: openapi.responses[401],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const STEP_UP =
  ' Needs a recent authentication: when the session’s last proof is older than ten minutes ' +
  '(or, for a user with two-step verification, did not include a second factor) it answers ' +
  '`auth.step_up_required` (403) with `params.methods`; call `POST /v1/client/sessions/step-up` ' +
  'and repeat the request with the access token it returns.'

const ORIGIN =
  ' Passkeys must be on for the environment (`auth.method_disabled` otherwise), and the ' +
  'request’s `Origin` must be one the environment allows and belong to its `passkeys.rpId` ' +
  '(`request.origin_not_allowed`). A native app sends no `Origin` and `x-tula-client: ios` or ' +
  '`android`: the response must then carry an origin of one of the environment’s registered ' +
  'apps of that platform, and with no such app the request is refused ' +
  '(`request.origin_not_allowed`).'

router.get(
  '/client/me/passkeys',
  describeRoute({
    operationId: 'listMyPasskeys',
    tags: ['Passkeys'],
    summary: 'List my passkeys',
    description:
      'The signed-in user’s passkeys, oldest first: a name, whether the authenticator reports ' +
      'it as synced, when it was added and last used. Never key material or a credential id.',
    security: openapi.security.session,
    responses: {
      200: { description: 'The passkeys.', content: json(PasskeyListSchema) },
      ...errors,
    },
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      PasskeyListSchema.parse({
        passkeys: await Passkeys.list(c.get('deps'), c.get('tenant'), c.get('session').sub),
      })
    )
  }
)

router.post(
  '/client/me/passkeys/options',
  describeRoute({
    operationId: 'startPasskeyRegistration',
    tags: ['Passkeys'],
    summary: 'Start registering a passkey',
    description:
      'The options for `navigator.credentials.create()`: a discoverable credential with user ' +
      'verification, no attestation, ES256, EdDSA or RS256, and the user’s existing passkeys ' +
      'in `excludeCredentials`. The challenge works once, for five minutes and only for the ' +
      'session that asked; asking again replaces it. A user may have ten passkeys ' +
      '(`passkey.limit_reached`, 409).' +
      ORIGIN +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      200: { description: 'The creation options.', content: json(PasskeyCreationOptionsSchema) },
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limited('passkey_register_start'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      PasskeyCreationOptionsSchema.parse(
        await Passkeys.startRegistration(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          Passkeys.ceremonyOf(c.req)
        )
      )
    )
  }
)

router.post(
  '/client/me/passkeys',
  describeRoute({
    operationId: 'finishPasskeyRegistration',
    tags: ['Passkeys'],
    summary: 'Finish registering a passkey',
    description:
      'Verifies what `navigator.credentials.create()` returned for the options of ' +
      '`POST /v1/client/me/passkeys/options` and stores the passkey’s public key. The ' +
      'challenge is used up by the first response presented for it. A response that does ' +
      'not verify (another challenge, origin or relying party, no user verification) is ' +
      '`passkey.registration_failed` (422); a credential that is already a passkey is ' +
      '`passkey.already_registered` (409). The owner is emailed.' +
      ORIGIN +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      201: { description: 'The stored passkey.', content: json(PasskeySchema) },
      403: openapi.responses[403],
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('passkey_register'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('json', PasskeyRegisterRequestSchema, validationHook),
  async (c) => {
    const { sub, sid } = c.get('session')
    c.header('Cache-Control', 'no-store')
    return c.json(
      PasskeySchema.parse(
        await Passkeys.finishRegistration(
          c.get('deps'),
          c.get('tenant'),
          { userId: sub, sessionId: sid },
          c.req.valid('json'),
          Passkeys.ceremonyOf(c.req),
          userActor(c)
        )
      ),
      201
    )
  }
)

router.patch(
  '/client/me/passkeys/:passkeyId',
  describeRoute({
    operationId: 'renamePasskey',
    tags: ['Passkeys'],
    summary: 'Rename a passkey',
    description: `Gives one of the signed-in user’s passkeys a new name.${STEP_UP}`,
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      200: { description: 'The renamed passkey.', content: json(PasskeySchema) },
      403: openapi.responses[403],
      404: openapi.responses[404],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('passkey_rename'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('param', PasskeyIdParamSchema, validationHook),
  validator('json', PasskeyRenameRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      PasskeySchema.parse(
        await Passkeys.rename(
          c.get('deps'),
          c.get('tenant'),
          c.get('session').sub,
          c.req.valid('param').passkeyId,
          c.req.valid('json').name,
          userActor(c)
        )
      )
    )
  }
)

router.delete(
  '/client/me/passkeys/:passkeyId',
  describeRoute({
    operationId: 'removePasskey',
    tags: ['Passkeys'],
    summary: 'Remove a passkey',
    description:
      'Removes one of the signed-in user’s passkeys. Refused with ' +
      '`passkey.last_sign_in_method` (409) when it is their only way to sign in: no password, ' +
      'no verified address where the email code is on, no connected provider and no other ' +
      'passkey. Works with passkeys switched off. The owner is emailed.' +
      STEP_UP,
    security: openapi.security.session,
    responses: {
      204: { description: 'Removed.' },
      403: openapi.responses[403],
      404: openapi.responses[404],
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  limited('passkey_remove'),
  publishableKey(),
  sessionAuth(),
  requireRecentAuth(),
  validator('param', PasskeyIdParamSchema, validationHook),
  async (c) => {
    await Passkeys.remove(
      c.get('deps'),
      c.get('tenant'),
      c.get('session').sub,
      c.req.valid('param').passkeyId,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
