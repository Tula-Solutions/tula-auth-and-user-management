import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit, byEnvironment, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as SsoConnections from '~/modules/sso-connection/service'
import * as openapi from '~/openapi'
import {
  CreateSsoConnectionRequestSchema,
  SsoConnectionIdParamSchema,
  SsoConnectionListQuerySchema,
  SsoConnectionListSchema,
  SsoConnectionSchema,
  UpdateSsoConnectionRequestSchema,
} from './schema'

/** Metadata refreshes a minute per environment: each one makes the server call an address. */
const REFRESH_RATE_LIMIT = 10

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

router.delete(
  '/:id',
  describeRoute({
    operationId: 'deleteSsoConnection',
    tags: ['SSO connections'],
    summary: 'Delete an SSO connection',
    description:
      'Deletes a connection nobody has signed in through. One with an identity is kept ' +
      '(`sso.connection_in_use`, 409): disable it instead.',
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
