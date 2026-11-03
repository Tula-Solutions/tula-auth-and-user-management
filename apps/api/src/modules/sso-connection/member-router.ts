import {
  CreateMySsoConnectionRequestSchema,
  SsoConnectionListSchema,
  SsoConnectionSchema,
  SsoGroupRolesSchema,
  SsoTestIdParamSchema,
  SsoTestResultSchema,
  SsoTestStartRequestSchema,
  SsoTestStartSchema,
  UpdateSsoConnectionRequestSchema,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { userActor } from '~/lib/actor'
import { publishableKey } from '~/middleware/publishable-key'
import { byEnvironment, byIp, rateLimit } from '~/middleware/rate-limit'
import { sessionAuth } from '~/middleware/session-auth'
import * as Mfa from '~/modules/mfa/service'
import * as Members from '~/modules/sso-connection/member-service'
import * as openapi from '~/openapi'

/** Requests per minute from one IP to each route that reads connections. */
export const SSO_MEMBER_READ_RATE_LIMIT = 60

/** Requests per minute from one IP to each route that changes a connection or its mapping. */
export const SSO_MEMBER_WRITE_RATE_LIMIT = 20

/** Metadata refreshes a minute per environment: each one makes the server call an address. */
const REFRESH_RATE_LIMIT = 10

/** Test sign-ins a minute per environment: each one makes the server call the provider. */
const TEST_RATE_LIMIT = 20

const OrganizationParam = z.object({ organizationId: z.uuid() })
const ConnectionParam = z.object({ organizationId: z.uuid(), id: z.uuid() })
const TestParam = SsoTestIdParamSchema.extend({ organizationId: z.uuid() })

// Mounted at `/v1/client/me/organizations`: what a signed-in member who holds
// `org:sys:sso:manage` does to their own organization's single sign-on (ADR 0067). The admin
// routes are `router.ts`; both call the same service functions.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  401: openapi.responses[401],
  403: openapi.responses[403],
  404: openapi.responses[404],
  422: openapi.responses[422],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
} as const

const needs =
  'Needs the permission `org:sys:sso:manage`, read from the caller’s membership on every call ' +
  '(never from the token’s claims): a user who is not a member answers ' +
  '`organization.not_a_member` and a member without it `auth.forbidden` (403). A connection ' +
  'of another organization is `sso.connection_not_found`. The client secret is accepted and ' +
  'never returned.'

const stepUp =
  'Switching enforcement off, trusting the provider for MFA and naming a break-glass role are ' +
  'weakenings: they need a **recent authentication** (`auth.step_up_required`, 403) and the ' +
  'audit entry says `weakened: true`.'

const limit = (name: string, max: number) =>
  rateLimit({ name, limit: max, window: '1m', key: byIp })

router.get(
  '/:organizationId/sso-connections',
  describeRoute({
    operationId: 'listMyOrganizationSsoConnections',
    tags: ['Organizations'],
    summary: 'List my organization’s SSO connections',
    description: `The organization’s single sign-on connections, with the service provider values to give the identity provider. ${needs}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The connections.', content: json(SsoConnectionListSchema) },
      ...errors,
    },
  }),
  limit('my_sso_list', SSO_MEMBER_READ_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', OrganizationParam, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const connections = await Members.list(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      c.req.valid('param').organizationId
    )
    return c.json(SsoConnectionListSchema.parse({ connections }))
  }
)

router.post(
  '/:organizationId/sso-connections',
  describeRoute({
    operationId: 'createMyOrganizationSsoConnection',
    tags: ['Organizations'],
    summary: 'Create an SSO connection',
    description: `Creates a draft connection for the organization; the role it gives must hold only permissions the caller holds (\`organization.role_not_assignable\`). ${needs}`,
    security: openapi.security.session,
    responses: {
      201: { description: 'The connection.', content: json(SsoConnectionSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
    },
  }),
  limit('my_sso_create', SSO_MEMBER_WRITE_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', OrganizationParam, validationHook),
  validator('json', CreateMySsoConnectionRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const created = await Members.create(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      c.req.valid('param').organizationId,
      c.req.valid('json'),
      userActor(c)
    )
    return c.json(SsoConnectionSchema.parse(created), 201)
  }
)

router.get(
  '/:organizationId/sso-connections/:id',
  describeRoute({
    operationId: 'getMyOrganizationSsoConnection',
    tags: ['Organizations'],
    summary: 'Get an SSO connection',
    description: `One connection of the organization. ${needs}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      ...errors,
    },
  }),
  limit('my_sso_get', SSO_MEMBER_READ_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', ConnectionParam, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id } = c.req.valid('param')
    return c.json(
      SsoConnectionSchema.parse(
        await Members.get(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          organizationId,
          id
        )
      )
    )
  }
)

router.patch(
  '/:organizationId/sso-connections/:id',
  describeRoute({
    operationId: 'updateMyOrganizationSsoConnection',
    tags: ['Organizations'],
    summary: 'Change an SSO connection',
    description: `Changes the fields sent and keeps the rest, as the admin route does. ${stepUp} ${needs}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
    },
  }),
  limit('my_sso_update', SSO_MEMBER_WRITE_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', ConnectionParam, validationHook),
  validator('json', UpdateSsoConnectionRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id } = c.req.valid('param')
    const updated = await Members.update(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      organizationId,
      id,
      c.req.valid('json'),
      userActor(c),
      () => Mfa.requireRecentAuthentication(c.get('deps'), c.get('tenant'), c.get('session'))
    )
    return c.json(SsoConnectionSchema.parse(updated))
  }
)

router.post(
  '/:organizationId/sso-connections/:id/refresh-metadata',
  describeRoute({
    operationId: 'refreshMyOrganizationSsoMetadata',
    tags: ['Organizations'],
    summary: 'Read a SAML connection’s metadata address again',
    description: `Takes a rotated certificate or a moved SSO URL from the metadata address, through the outbound guard. Limited to ${REFRESH_RATE_LIMIT} a minute per environment. ${needs}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      ...errors,
    },
  }),
  limit('my_sso_refresh_ip', SSO_MEMBER_WRITE_RATE_LIMIT),
  rateLimit({
    name: 'sso_refresh_metadata',
    limit: REFRESH_RATE_LIMIT,
    window: '1m',
    key: byEnvironment,
  }),
  publishableKey(),
  sessionAuth(),
  validator('param', ConnectionParam, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id } = c.req.valid('param')
    return c.json(
      SsoConnectionSchema.parse(
        await Members.refreshMetadata(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          organizationId,
          id,
          userActor(c)
        )
      )
    )
  }
)

router.post(
  '/:organizationId/sso-connections/:id/tests',
  describeRoute({
    operationId: 'startMyOrganizationSsoConnectionTest',
    tags: ['Organizations'],
    summary: 'Start a test sign-in of an SSO connection',
    description: `Runs the whole sign-in round through the identity provider without creating a session, user or membership. Send the browser to \`authorizationUrl\`; it returns to \`redirectUrl\` (an address the environment allows) with \`#tula_test=<testId>\`. A passing test of the connection’s current settings is required to turn it on (\`sso.test_required\`, 409). Limited to ${TEST_RATE_LIMIT} a minute per environment. ${needs}`,
    security: openapi.security.session,
    responses: {
      201: { description: 'The test.', content: json(SsoTestStartSchema) },
      413: openapi.responses[413],
      ...errors,
    },
  }),
  limit('my_sso_test_ip', SSO_MEMBER_WRITE_RATE_LIMIT),
  rateLimit({ name: 'sso_test', limit: TEST_RATE_LIMIT, window: '1m', key: byEnvironment }),
  publishableKey(),
  sessionAuth(),
  validator('param', ConnectionParam, validationHook),
  validator('json', SsoTestStartRequestSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id } = c.req.valid('param')
    const started = await Members.startTest(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      organizationId,
      id,
      c.req.valid('json').redirectUrl,
      userActor(c)
    )
    return c.json(SsoTestStartSchema.parse(started), 201)
  }
)

router.get(
  '/:organizationId/sso-connections/:id/tests/:testId',
  describeRoute({
    operationId: 'getMyOrganizationSsoConnectionTest',
    tags: ['Organizations'],
    summary: 'Read the result of a test sign-in',
    description: `The attributes and groups that arrived, how they mapped, or the reason the test failed. \`pending\` until the browser has come back. ${needs}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The result.', content: json(SsoTestResultSchema) },
      ...errors,
    },
  }),
  limit('my_sso_test_read_ip', SSO_MEMBER_READ_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', TestParam, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id, testId } = c.req.valid('param')
    return c.json(
      SsoTestResultSchema.parse(
        await Members.testResult(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          organizationId,
          id,
          testId
        )
      )
    )
  }
)

router.delete(
  '/:organizationId/sso-connections/:id',
  describeRoute({
    operationId: 'deleteMyOrganizationSsoConnection',
    tags: ['Organizations'],
    summary: 'Delete an SSO connection',
    description: `Deletes a connection nobody has signed in through (\`sso.connection_in_use\`, 409, otherwise: disable it). ${needs}`,
    security: openapi.security.session,
    responses: {
      204: { description: 'Deleted.' },
      409: openapi.responses[409],
      ...errors,
    },
  }),
  limit('my_sso_delete', SSO_MEMBER_WRITE_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', ConnectionParam, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id } = c.req.valid('param')
    await Members.remove(
      c.get('deps'),
      c.get('tenant'),
      { userId: c.get('session').sub },
      organizationId,
      id,
      userActor(c)
    )
    return c.body(null, 204)
  }
)

router.get(
  '/:organizationId/sso-connections/:id/group-roles',
  describeRoute({
    operationId: 'getMyOrganizationSsoGroupRoles',
    tags: ['Organizations'],
    summary: 'Get the IdP group to role mapping',
    description: `The organization’s mapping in precedence order. ${needs}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The mapping.', content: json(SsoGroupRolesSchema) },
      ...errors,
    },
  }),
  limit('my_sso_group_roles_get', SSO_MEMBER_READ_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', ConnectionParam, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id } = c.req.valid('param')
    return c.json(
      SsoGroupRolesSchema.parse(
        await Members.getGroupRoles(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          organizationId,
          id
        )
      )
    )
  }
)

router.put(
  '/:organizationId/sso-connections/:id/group-roles',
  describeRoute({
    operationId: 'replaceMyOrganizationSsoGroupRoles',
    tags: ['Organizations'],
    summary: 'Replace the IdP group to role mapping',
    description: `Replaces the whole mapping. Every role must hold only permissions the caller holds (\`organization.role_not_assignable\`), or a manager could map a group to a role above their own. ${needs}`,
    security: openapi.security.session,
    responses: {
      200: { description: 'The mapping as saved.', content: json(SsoGroupRolesSchema) },
      413: openapi.responses[413],
      ...errors,
    },
  }),
  limit('my_sso_group_roles_put', SSO_MEMBER_WRITE_RATE_LIMIT),
  publishableKey(),
  sessionAuth(),
  validator('param', ConnectionParam, validationHook),
  validator('json', SsoGroupRolesSchema, validationHook),
  async (c) => {
    c.header('Cache-Control', 'no-store')
    const { organizationId, id } = c.req.valid('param')
    return c.json(
      SsoGroupRolesSchema.parse(
        await Members.putGroupRoles(
          c.get('deps'),
          c.get('tenant'),
          { userId: c.get('session').sub },
          organizationId,
          id,
          c.req.valid('json'),
          userActor(c)
        )
      )
    )
  }
)

export default router
