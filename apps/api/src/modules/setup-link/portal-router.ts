import {
  SetupConnectionCreateSchema,
  SetupConnectionUpdateSchema,
  SetupGroupRolesSchema,
  SetupPortalSchema,
  SetupScimTokenCreateSchema,
  SsoConnectionSchema,
  SsoGroupRolesSchema,
  SsoTestResultSchema,
  SsoTestStartSchema,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { setupLinkActor } from '~/lib/actor'
import { byEnvironment, byIp, rateLimit } from '~/middleware/rate-limit'
import { SETUP_IP_RATE_LIMIT, setupLink } from '~/middleware/setup-link'
import { CreatedScimTokenSchema } from '~/modules/scim-token/schema'
import { SsoConnectionIdParamSchema, SsoTestIdParamSchema } from '~/modules/sso-connection/schema'
import * as openapi from '~/openapi'
import * as Portal from './portal'

/** Metadata refreshes a minute per environment: each one makes the server call an address. */
const REFRESH_RATE_LIMIT = 10

/** SCIM tokens a minute per environment: each one is a credential handed out. */
const SCIM_TOKEN_RATE_LIMIT = 20

/** Test sign-ins a minute per environment: each one makes the server call the provider. */
const TEST_RATE_LIMIT = 20

// What a setup link opens (ADR 0067, "Setup links"), mounted at `/v1/setup`. The per-IP limit
// comes first so that guessing tokens is counted; `setupLink()` then reads the token from
// `x-tula-setup-token` alone. Every answer is `no-store` and `Referrer-Policy: no-referrer`.
// Each handler passes the link's organization from the middleware, never from the request.
const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  401: openapi.responses[401],
  404: openapi.responses[404],
  422: openapi.responses[422],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

const noStore = createMiddleware(async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
})

const ipLimit = rateLimit({
  name: 'setup_ip',
  limit: SETUP_IP_RATE_LIMIT,
  window: '1m',
  key: byIp,
})

router.get(
  '/',
  describeRoute({
    operationId: 'getSetupPortal',
    tags: ['SSO setup links'],
    summary: 'Open the setup portal',
    description:
      'The organization the link is for, its verified domains, when the link ends and the ' +
      'organization’s connections. Every failure of the token is `auth.invalid_key`.',
    security: openapi.security.setup,
    responses: {
      200: { description: 'The portal.', content: json(SetupPortalSchema) },
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  async (c) => {
    const view = await Portal.show(c.get('deps'), c.get('tenant'), c.get('setupLink'))
    return c.json(SetupPortalSchema.parse(view))
  }
)

router.post(
  '/connections',
  describeRoute({
    operationId: 'createSetupConnection',
    tags: ['SSO setup links'],
    summary: 'Create a draft SSO connection for the link’s organization',
    description:
      'The organization is the link’s. The body cannot set the default role, enforcement, ' +
      'trust of the provider’s MFA claim or a break-glass role: those stay with the operator ' +
      'and the organization’s administrators.',
    security: openapi.security.setup,
    responses: {
      201: { description: 'The connection.', content: json(SsoConnectionSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  validator('json', SetupConnectionCreateSchema, validationHook),
  async (c) => {
    const created = await Portal.createConnection(
      c.get('deps'),
      c.get('tenant'),
      c.get('setupLink'),
      c.req.valid('json'),
      setupLinkActor(c)
    )
    return c.json(SsoConnectionSchema.parse(created), 201)
  }
)

router.post(
  '/scim-tokens',
  describeRoute({
    operationId: 'createSetupScimToken',
    tags: ['SSO setup links'],
    summary: 'Create a SCIM token for the link’s organization',
    description:
      'The organization is the link’s. The secret is in this answer and nowhere else; the ' +
      `portal cannot list or read a token. Limited to ${SCIM_TOKEN_RATE_LIMIT} a minute per environment.`,
    security: openapi.security.setup,
    responses: {
      201: { description: 'The token and its secret.', content: json(CreatedScimTokenSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  rateLimit({
    name: 'setup_scim_token',
    limit: SCIM_TOKEN_RATE_LIMIT,
    window: '1m',
    key: byEnvironment,
  }),
  validator('json', SetupScimTokenCreateSchema, validationHook),
  async (c) => {
    const created = await Portal.createScimToken(
      c.get('deps'),
      c.get('tenant'),
      c.get('setupLink'),
      c.req.valid('json'),
      setupLinkActor(c)
    )
    return c.json(CreatedScimTokenSchema.parse(created), 201)
  }
)

router.get(
  '/connections/:id',
  describeRoute({
    operationId: 'getSetupConnection',
    tags: ['SSO setup links'],
    summary: 'Read one of the link’s organization’s connections',
    description: 'Another organization’s connection is `sso.connection_not_found`.',
    security: openapi.security.setup,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) =>
    c.json(
      SsoConnectionSchema.parse(
        await Portal.getConnection(
          c.get('deps'),
          c.get('tenant'),
          c.get('setupLink'),
          c.req.valid('param').id
        )
      )
    )
)

router.patch(
  '/connections/:id',
  describeRoute({
    operationId: 'updateSetupConnection',
    tags: ['SSO setup links'],
    summary: 'Change one of the link’s organization’s connections',
    description:
      'The provider settings, the attribute mapping and the domains, and a status that can ' +
      'only be `active`, which still needs a passing test of the current settings.',
    security: openapi.security.setup,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  validator('json', SetupConnectionUpdateSchema, validationHook),
  async (c) => {
    const updated = await Portal.updateConnection(
      c.get('deps'),
      c.get('tenant'),
      c.get('setupLink'),
      c.req.valid('param').id,
      c.req.valid('json'),
      setupLinkActor(c)
    )
    return c.json(SsoConnectionSchema.parse(updated))
  }
)

router.post(
  '/connections/:id/refresh-metadata',
  describeRoute({
    operationId: 'refreshSetupConnectionMetadata',
    tags: ['SSO setup links'],
    summary: 'Read a SAML connection’s metadata address again',
    description: `Limited to ${REFRESH_RATE_LIMIT} such requests a minute per environment.`,
    security: openapi.security.setup,
    responses: {
      200: { description: 'The connection.', content: json(SsoConnectionSchema) },
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  rateLimit({
    name: 'sso_refresh_metadata',
    limit: REFRESH_RATE_LIMIT,
    window: '1m',
    key: byEnvironment,
  }),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) => {
    const refreshed = await Portal.refreshMetadata(
      c.get('deps'),
      c.get('tenant'),
      c.get('setupLink'),
      c.req.valid('param').id,
      setupLinkActor(c)
    )
    return c.json(SsoConnectionSchema.parse(refreshed))
  }
)

router.get(
  '/connections/:id/group-roles',
  describeRoute({
    operationId: 'getSetupGroupRoles',
    tags: ['SSO setup links'],
    summary: 'Get the organization’s IdP group to role mapping',
    security: openapi.security.setup,
    responses: {
      200: { description: 'The mapping.', content: json(SetupGroupRolesSchema) },
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) =>
    c.json(
      SetupGroupRolesSchema.parse(
        await Portal.getGroupRoles(
          c.get('deps'),
          c.get('tenant'),
          c.get('setupLink'),
          c.req.valid('param').id
        )
      )
    )
)

router.put(
  '/connections/:id/group-roles',
  describeRoute({
    operationId: 'replaceSetupGroupRoles',
    tags: ['SSO setup links'],
    summary: 'Replace the organization’s IdP group to role mapping',
    description:
      'Replaces the whole mapping. The holder of a link decides which of the provider’s ' +
      'groups become which role (ADR 0067); the operator who made the link trusted them with it.',
    security: openapi.security.setup,
    responses: {
      200: { description: 'The mapping as saved.', content: json(SetupGroupRolesSchema) },
      413: openapi.responses[413],
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  validator('json', SsoGroupRolesSchema, validationHook),
  async (c) =>
    c.json(
      SetupGroupRolesSchema.parse(
        await Portal.putGroupRoles(
          c.get('deps'),
          c.get('tenant'),
          c.get('setupLink'),
          c.req.valid('param').id,
          c.req.valid('json'),
          setupLinkActor(c)
        )
      )
    )
)

router.post(
  '/connections/:id/tests',
  describeRoute({
    operationId: 'startSetupConnectionTest',
    tags: ['SSO setup links'],
    summary: 'Start a test sign-in',
    description:
      'Starts the round through the identity provider without creating a session, user, ' +
      'identity or membership. The browser returns to the portal page, an address the server ' +
      'builds; the body takes none.',
    security: openapi.security.setup,
    responses: {
      201: { description: 'The test.', content: json(SsoTestStartSchema) },
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  rateLimit({ name: 'sso_test', limit: TEST_RATE_LIMIT, window: '1m', key: byEnvironment }),
  validator('param', SsoConnectionIdParamSchema, validationHook),
  async (c) => {
    const started = await Portal.startTest(
      c.get('deps'),
      c.get('tenant'),
      c.get('setupLink'),
      c.req.valid('param').id,
      setupLinkActor(c)
    )
    return c.json(SsoTestStartSchema.parse(started), 201)
  }
)

router.get(
  '/connections/:id/tests/:testId',
  describeRoute({
    operationId: 'getSetupConnectionTest',
    tags: ['SSO setup links'],
    summary: 'Read the result of a test sign-in',
    security: openapi.security.setup,
    responses: {
      200: { description: 'The result.', content: json(SsoTestResultSchema) },
      ...errors,
    },
  }),
  noStore,
  ipLimit,
  setupLink(),
  validator('param', SsoTestIdParamSchema, validationHook),
  async (c) => {
    const { id, testId } = c.req.valid('param')
    return c.json(
      SsoTestResultSchema.parse(
        await Portal.testResult(c.get('deps'), c.get('tenant'), c.get('setupLink'), id, testId)
      )
    )
  }
)

export default router
