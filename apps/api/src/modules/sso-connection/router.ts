import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { publicBase } from '~/lib/public-base'
import { adminRateLimit, byEnvironment, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import { PORTAL_PATH } from '~/modules/setup-link/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import * as SsoTests from '~/modules/sso-test/service'
import * as openapi from '~/openapi'
import {
  AdminSsoTestStartRequestSchema,
  CreateSsoConnectionRequestSchema,
  SsoConnectionIdParamSchema,
  SsoConnectionListQuerySchema,
  SsoConnectionListSchema,
  SsoConnectionSchema,
  SsoGroupRolesSchema,
  SsoTestIdParamSchema,
  SsoTestResultSchema,
  SsoTestStartSchema,
  UpdateSsoConnectionRequestSchema,
} from './schema'

/** Metadata refreshes a minute per environment: each one makes the server call an address. */
const REFRESH_RATE_LIMIT = 10

/** Test sign-ins a minute per environment: each one makes the server call the provider. */
const TEST_RATE_LIMIT = 20

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  404: openapi.responses[404],
  422: openapi.responses[422],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

const weakening =
  'Activating a connection, and changing the issuer, client, secret, role or domains of an ' +
  'active one, widens who can sign in: the audit entry carries `weakened: true`. The client ' +
  'secret is sealed and never returned.'

router.get(
  '/',
  describeRoute({
    operationId: 'listSsoConnections',
    tags: ['SSO connections'],
    summary: 'List an organization’s SSO connections',
    description:
      'The single sign-on connections of one organization, or of the whole environment when `organizationId` is left out, oldest first.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The connections.', content: json(SsoConnectionListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('query', SsoConnectionListQuerySchema, validationHook),
  async (c) => {
    const connections = await SsoConnections.list(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('query').organizationId
    )
    return c.json(SsoConnectionListSchema.parse({ connections }))
  }
)

router.post(
  '/',
  describeRoute({
    operationId: 'createSsoConnection',
    tags: ['SSO connections'],
    summary: 'Create an SSO connection',
    description:
      'Creates an OIDC connection for an organization as a draft, bound to some of its ' +
      'verified domains. The issuer is checked against the outbound rules. A draft signs ' +
      `nobody in; activate it with an update. ${weakening}`,
    security: openapi.security.admin,
    responses: {
      201: { description: 'The connection.', content: json(SsoConnectionSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateSsoConnectionRequestSchema, validationHook),
  async (c) => {
    const created = await SsoConnections.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    return c.json(SsoConnectionSchema.parse(created), 201)
  }
)

router.get(
  '/:id',
  describeRoute({
    operationId: 'getSsoConnection',
    tags: ['SSO connections'],
    summary: 'Get an SSO connection',
    description: 'One connection of the environment, without its secret.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) => {
    const connection = await SsoConnections.get(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id
    )
    return c.json(SsoConnectionSchema.parse(connection))
  }
)

router.get(
  '/:id/group-roles',
  describeRoute({
    operationId: 'getSsoGroupRoles',
    tags: ['SSO connections'],
    summary: "Get an organization's IdP group to role mapping",
    description:
      "The mapping of the connection's organization, in precedence order: the first of a " +
      "user's groups in this list decides their role. SCIM Groups use the same mapping.",
    security: openapi.security.admin,
    responses: {
      200: { description: 'The mapping.', content: json(SsoGroupRolesSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) =>
    c.json(
      SsoGroupRolesSchema.parse(
        await SsoConnections.getGroupRoles(c.get('deps'), c.get('tenant'), c.req.valid('param').id)
      )
    )
)

router.put(
  '/:id/group-roles',
  describeRoute({
    operationId: 'replaceSsoGroupRoles',
    tags: ['SSO connections'],
    summary: "Replace an organization's IdP group to role mapping",
    description:
      'Replaces the whole mapping. A role that does not exist is refused ' +
      '(`organization.role_unknown`); a group named twice is `request.malformed`. At each ' +
      "single sign-on the member's role is set from it, and a user in no mapped group gets " +
      "the connection's `defaultRole`. The audit entry says only that the mapping changed.",
    security: openapi.security.admin,
    responses: {
      200: { description: 'The mapping as saved.', content: json(SsoGroupRolesSchema) },
      413: openapi.responses[413],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  validator('json', SsoGroupRolesSchema, validationHook),
  async (c) =>
    c.json(
      SsoGroupRolesSchema.parse(
        await SsoConnections.putGroupRoles(
          c.get('deps'),
          c.get('tenant'),
          c.req.valid('param').id,
          c.req.valid('json'),
          adminActor(c)
        )
      )
    )
)

router.patch(
  '/:id',
  describeRoute({
    operationId: 'updateSsoConnection',
    tags: ['SSO connections'],
    summary: 'Change an SSO connection',
    description:
      'Changes the fields sent and keeps the rest. A status moves draft to active to ' +
      'disabled, never back to a draft; a domain belongs to at most one active connection ' +
      `(\`sso.domain_taken\`, 409). ${weakening}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  validator('json', UpdateSsoConnectionRequestSchema, validationHook),
  async (c) => {
    const updated = await SsoConnections.update(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      c.req.valid('json'),
      adminActor(c)
    )
    return c.json(SsoConnectionSchema.parse(updated))
  }
)

router.post(
  '/:id/refresh-metadata',
  describeRoute({
    operationId: 'refreshSsoConnectionMetadata',
    tags: ['SSO connections'],
    summary: 'Read a SAML connection’s metadata address again',
    description:
      'Fetches the identity provider’s metadata from the address the connection was given ' +
      '(through the outbound guard: a private address is refused) and takes its entity id, ' +
      'SSO URL and signing certificates. `sso.saml_invalid` when the connection was not ' +
      `given an address. Limited to ${REFRESH_RATE_LIMIT} such requests a minute per environment. ${weakening}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  rateLimit({
    name: 'sso_refresh_metadata',
    limit: REFRESH_RATE_LIMIT,
    window: '1m',
    key: byEnvironment,
  }),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) => {
    const refreshed = await SsoConnections.refreshMetadata(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      adminActor(c)
    )
    return c.json(SsoConnectionSchema.parse(refreshed))
  }
)

router.post(
  '/:id/tests',
  describeRoute({
    operationId: 'startSsoConnectionTest',
    tags: ['SSO connections'],
    summary: 'Start a test sign-in of an SSO connection',
    description:
      'Starts the whole sign-in round through the identity provider without creating a ' +
      'session, user, identity or membership. Send the browser to `authorizationUrl`; it ' +
      'returns to `redirectUrl` (an address the environment allows; left out, the server’s own setup page) with `#tula_test=<testId>`, ' +
      'and the result is read with `GET /:id/tests/:testId`. A passing test of the ' +
      'connection’s current settings is required to activate it.',
    security: openapi.security.admin,
    responses: {
      201: { description: 'The test.', content: json(SsoTestStartSchema) },
      413: openapi.responses[413],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  rateLimit({ name: 'sso_test', limit: TEST_RATE_LIMIT, window: '1m', key: byEnvironment }),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  validator('json', AdminSsoTestStartRequestSchema, validationHook),
  async (c) => {
    const { redirectUrl } = c.req.valid('json')
    // No address sent: the server's own setup page, built from PUBLIC_URL, so it is not held
    // to the environment's list (the dashboard's popup round, like the setup portal's).
    const started = await SsoTests.start(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      redirectUrl ?? `${publicBase(c.get('deps').config)}${PORTAL_PATH}`,
      adminActor(c),
      redirectUrl === undefined
    )
    return c.json(SsoTestStartSchema.parse(started), 201)
  }
)

router.get(
  '/:id/tests/:testId',
  describeRoute({
    operationId: 'getSsoConnectionTest',
    tags: ['SSO connections'],
    summary: 'Read the result of a test sign-in',
    description:
      'The attributes and groups that arrived, how they mapped, or the reason the test failed ' +
      'with a sentence for it. `pending` until the browser has come back. It holds no ' +
      'assertion and no token. This is the one place a refusal’s reason is shown.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The result.', content: json(SsoTestResultSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', SsoTestIdParamSchema, validationHook),
  async (c) => {
    const { id, testId } = c.req.valid('param')
    return c.json(
      SsoTestResultSchema.parse(await SsoTests.result(c.get('deps'), c.get('tenant'), id, testId))
    )
  }
)

router.delete(
  '/:id',
  describeRoute({
    operationId: 'deleteSsoConnection',
    tags: ['SSO connections'],
    summary: 'Delete an SSO connection',
    description:
      'Deletes a connection that is not active, with its identities; the users it managed ' +
      'keep their accounts. An active one is kept (`sso.connection_in_use`, 409): disable it first.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'Deleted.' },
      409: openapi.responses[409],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) => {
    await SsoConnections.remove(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      adminActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
