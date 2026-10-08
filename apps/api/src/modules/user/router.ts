import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor, requestOrigin } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { adminRateLimit, byIp, rateLimit } from '~/middleware/rate-limit'
import { requireRecentAuth } from '~/middleware/recent-auth'
import { secretKey } from '~/middleware/secret-key'
import { sessionAuth } from '~/middleware/session-auth'
import * as Users from '~/modules/user/service'
import * as openapi from '~/openapi'
import {
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  CurrentUserSchema,
  SetPasswordRequestSchema,
  UserAuthenticationSchema,
  UserIdParamSchema,
  UserListQuerySchema,
  UserListSchema,
  UserSchema,
} from './schema'

/** Password changes per minute from one IP; the service also limits guesses per user. */
export const PASSWORD_CHANGE_RATE_LIMIT = 10

// Mounted at `/v1`: this module serves both the admin routes and the signed-in user's own.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const adminErrors = {
  401: openapi.responses[401],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

router.get(
  '/admin/users',
  describeRoute({
    operationId: 'listUsers',
    tags: ['Users'],
    summary: 'List users',
    description:
      'Users of the secret key’s environment, one page at a time. `q` matches part of the ' +
      'email or a name; `sort` takes a field name, prefixed with `-` for descending.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'One page of users.', content: json(UserListSchema) },
      422: openapi.responses[422],
      ...adminErrors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('query', UserListQuerySchema, validationHook),
  async (c) =>
    c.json(
      UserListSchema.parse(await Users.list(c.get('deps'), c.get('tenant'), c.req.valid('query')))
    )
)

router.post(
  '/admin/users',
  describeRoute({
    operationId: 'createUser',
    tags: ['Users'],
    summary: 'Create a user',
    description:
      'Creates a user. A `password`, when given, must meet the environment’s policy; without ' +
      'one the user has no password and gets one through a password reset or the admin ' +
      '"set password". The email is unverified unless `emailVerified` is true. A taken email ' +
      'answers 409.',
    security: openapi.security.admin,
    responses: {
      413: openapi.responses[413],
      201: { description: 'The created user.', content: json(UserSchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...adminErrors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateUserRequestSchema, validationHook),
  async (c) =>
    c.json(
      UserSchema.parse(
        await Users.create(c.get('deps'), c.get('tenant'), c.req.valid('json'), adminActor(c))
      ),
      201
    )
)

router.get(
  '/admin/users/:userId',
  describeRoute({
    operationId: 'getUser',
    tags: ['Users'],
    summary: 'Get a user',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The user.', content: json(UserSchema) },
      422: openapi.responses[422],
      ...adminErrors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  async (c) =>
    c.json(
      UserSchema.parse(await Users.get(c.get('deps'), c.get('tenant'), c.req.valid('param').userId))
    )
)

router.get(
  '/admin/users/:userId/authentication',
  describeRoute({
    operationId: 'getUserAuthentication',
    tags: ['Users'],
    summary: 'Get how a user signs in',
    description:
      'The sign-in methods the account has: whether it has a password and a verified ' +
      'address, the provider accounts connected to it, its confirmed second factors with ' +
      'the number of unused backup codes, and its passkeys. Never a secret: no authenticator ' +
      'secret, backup code, credential id, public key or provider account id.\n\n' +
      '`canSignInWithoutPasskeys` says whether a method the environment accepts would remain ' +
      'if the passkeys were removed, which is what `DELETE /v1/admin/users/{userId}/factors` ' +
      'does: `false` means that reset would leave the user no way in.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The user’s sign-in methods.',
        content: json(UserAuthenticationSchema),
      },
      422: openapi.responses[422],
      ...adminErrors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  async (c) => {
    // What an account is protected by is not something a cache between here and the caller
    // should hold on to.
    c.header('Cache-Control', 'no-store')
    return c.json(
      UserAuthenticationSchema.parse(
        await Users.authentication(c.get('deps'), c.get('tenant'), c.req.valid('param').userId)
      )
    )
  }
)

router.delete(
  '/admin/users/:userId',
  describeRoute({
    operationId: 'deleteUser',
    tags: ['Users'],
    summary: 'Delete a user',
    description: 'Ends the user’s sessions and deletes them with everything they own.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'The user was deleted.' },
      422: openapi.responses[422],
      ...adminErrors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  async (c) => {
    await Users.remove(c.get('deps'), c.get('tenant'), c.req.valid('param').userId, adminActor(c))
    return c.body(null, 204)
  }
)

for (const [action, operationId, summary, description] of [
  [
    'ban',
    'banUser',
    'Ban a user',
    'The user can no longer sign in or refresh, and every session ends now.',
  ],
  ['unban', 'unbanUser', 'Unban a user', 'Lifts the ban. The user has to sign in again.'],
] as const) {
  router.post(
    `/admin/users/:userId/${action}`,
    describeRoute({
      operationId,
      tags: ['Users'],
      summary,
      description,
      security: openapi.security.admin,
      responses: {
        200: { description: 'The user.', content: json(UserSchema) },
        422: openapi.responses[422],
        ...adminErrors,
        ...openapi.adminResponses,
      },
    }),
    adminRateLimit(),
    secretKey(),
    validator('param', UserIdParamSchema, validationHook),
    async (c) =>
      c.json(
        UserSchema.parse(
          await Users[action](
            c.get('deps'),
            c.get('tenant'),
            c.req.valid('param').userId,
            adminActor(c)
          )
        )
      )
  )
}

router.put(
  '/admin/users/:userId/password',
  describeRoute({
    operationId: 'setUserPassword',
    tags: ['Users'],
    summary: 'Set a user’s password',
    description:
      'Replaces the password (it must meet the policy), or creates it for a user who has ' +
      'none, and ends every session of the user.',
    security: openapi.security.admin,
    responses: {
      413: openapi.responses[413],
      204: { description: 'The password was replaced.' },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...adminErrors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  validator('json', SetPasswordRequestSchema, validationHook),
  async (c) => {
    await Users.setPassword(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').userId,
      c.req.valid('json').password,
      adminActor(c)
    )
    return c.body(null, 204)
  }
)

router.get(
  '/client/me',
  describeRoute({
    operationId: 'getMe',
    tags: ['Users'],
    summary: 'Get the signed-in user',
    description:
      'The user the access token belongs to. `hasPassword` says whether the account has a ' +
      'password (someone who signed up through a provider or by email has none).',
    security: openapi.security.session,
    responses: {
      200: { description: 'The signed-in user.', content: json(CurrentUserSchema) },
      401: openapi.responses[401],
      404: openapi.responses[404],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      CurrentUserSchema.parse(await Users.me(c.get('deps'), c.get('tenant'), c.get('session').sub))
    )
  }
)

router.post(
  '/client/me/password',
  describeRoute({
    operationId: 'changeMyPassword',
    tags: ['Users'],
    summary: 'Change my password',
    description:
      'Requires the current password. On success the user’s other sessions end and this ' +
      'device stays signed in. A wrong current password answers `auth.invalid_credentials`. ' +
      'An account that has no password answers `password.not_set` (409): a first password is ' +
      'set through a password reset. A user with two-step verification must also have proven ' +
      'their second factor in the last ten minutes: otherwise `auth.step_up_required` (403).',
    security: openapi.security.session,
    responses: {
      413: openapi.responses[413],
      204: { description: 'The password was changed.' },
      401: openapi.responses[401],
      // `auth.step_up_required`: a user with a second factor has not proven it recently.
      403: openapi.responses[403],
      // `password.not_set`: the account has no password to change.
      409: openapi.responses[409],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  rateLimit({
    name: 'password_change',
    limit: PASSWORD_CHANGE_RATE_LIMIT,
    window: '1m',
    key: byIp,
  }),
  publishableKey(),
  sessionAuth(),
  // For a user with a second factor the current password is not enough: a stolen session plus a
  // known password would otherwise replace the password. Everyone else is unaffected.
  requireRecentAuth({ onlyWithSecondFactor: true }),
  validator('json', ChangePasswordRequestSchema, validationHook),
  async (c) => {
    const { sub, sid } = c.get('session')
    await Users.changePassword(
      c.get('deps'),
      c.get('tenant'),
      { userId: sub, sessionId: sid },
      c.req.valid('json'),
      requestOrigin(c)
    )
    return c.body(null, 204)
  }
)

export default router
