import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { publishableKey } from '~/middleware/publishable-key'
import { adminRateLimit, byIp, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import { sessionAuth } from '~/middleware/session-auth'
import * as Users from '~/modules/user/service'
import * as openapi from '~/openapi'
import {
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  SetPasswordRequestSchema,
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
      'Creates a user with a password that must meet the environment’s policy. The email is ' +
      'unverified unless `emailVerified` is true. A taken email answers 409.',
    security: openapi.security.admin,
    responses: {
      201: { description: 'The created user.', content: json(UserSchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...adminErrors,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateUserRequestSchema, validationHook),
  async (c) =>
    c.json(
      UserSchema.parse(await Users.create(c.get('deps'), c.get('tenant'), c.req.valid('json'))),
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
      404: openapi.responses[404],
      422: openapi.responses[422],
      ...adminErrors,
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
      404: openapi.responses[404],
      422: openapi.responses[422],
      ...adminErrors,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', UserIdParamSchema, validationHook),
  async (c) => {
    await Users.remove(c.get('deps'), c.get('tenant'), c.req.valid('param').userId)
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
        404: openapi.responses[404],
        422: openapi.responses[422],
        ...adminErrors,
      },
    }),
    adminRateLimit(),
    secretKey(),
    validator('param', UserIdParamSchema, validationHook),
    async (c) =>
      c.json(
        UserSchema.parse(
          await Users[action](c.get('deps'), c.get('tenant'), c.req.valid('param').userId)
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
      'Replaces the password (it must meet the policy) and ends every session of the user.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'The password was replaced.' },
      404: openapi.responses[404],
      422: openapi.responses[422],
      ...adminErrors,
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
      c.req.valid('json').password
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
    security: openapi.security.session,
    responses: {
      200: { description: 'The signed-in user.', content: json(UserSchema) },
      401: openapi.responses[401],
      404: openapi.responses[404],
      429: openapi.responses[429],
      500: openapi.responses[500],
    },
  }),
  publishableKey(),
  sessionAuth(),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      UserSchema.parse(await Users.me(c.get('deps'), c.get('tenant'), c.get('session').sub))
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
      'device stays signed in. A wrong current password answers `auth.invalid_credentials`.',
    security: openapi.security.session,
    responses: {
      204: { description: 'The password was changed.' },
      401: openapi.responses[401],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
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
  validator('json', ChangePasswordRequestSchema, validationHook),
  async (c) => {
    const { sub, sid } = c.get('session')
    await Users.changePassword(
      c.get('deps'),
      c.get('tenant'),
      { userId: sub, sessionId: sid },
      c.req.valid('json')
    )
    return c.body(null, 204)
  }
)

export default router
