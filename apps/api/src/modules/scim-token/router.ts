import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as ScimTokens from '~/modules/scim-token/service'
import * as openapi from '~/openapi'
import {
  CreatedScimTokenSchema,
  CreateScimTokenRequestSchema,
  ScimTokenIdParamSchema,
  ScimTokenListSchema,
  ScimTokenQuerySchema,
} from './schema'

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  404: openapi.responses[404],
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

router.get(
  '/',
  describeRoute({
    operationId: 'listScimTokens',
    tags: ['SCIM tokens'],
    summary: 'List an organization’s SCIM tokens',
    description: 'The tokens of one organization, revoked ones included, newest first. No secrets.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The tokens.', content: json(ScimTokenListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('query', ScimTokenQuerySchema, validationHook),
  async (c) => {
    const tokens = await ScimTokens.list(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('query').organizationId
    )
    return c.json(ScimTokenListSchema.parse({ tokens }))
  }
)

router.post(
  '/',
  describeRoute({
    operationId: 'createScimToken',
    tags: ['SCIM tokens'],
    summary: 'Create a SCIM token',
    description:
      'Creates the bearer token an organization’s identity provider presents to ' +
      '`/v1/scim/v2`. The token is in this answer and nowhere else: only its hash is stored. ' +
      'An organization holds at most ten live tokens (`resource.conflict`, 409).',
    security: openapi.security.admin,
    responses: {
      201: { description: 'The token, with its secret.', content: json(CreatedScimTokenSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateScimTokenRequestSchema, validationHook),
  async (c) => {
    const created = await ScimTokens.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    c.header('Cache-Control', 'no-store')
    return c.json(CreatedScimTokenSchema.parse(created), 201)
  }
)

router.delete(
  '/:id',
  describeRoute({
    operationId: 'revokeScimToken',
    tags: ['SCIM tokens'],
    summary: 'Revoke a SCIM token',
    description:
      'Revokes a token that is not revoked yet. The identity provider holding it is refused ' +
      'from its next request; users it provisioned keep their accounts.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'Revoked.' },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', ScimTokenIdParamSchema, validationHook),
  validator('query', ScimTokenQuerySchema, validationHook),
  async (c) => {
    await ScimTokens.revoke(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('query').organizationId,
      c.req.valid('param').id,
      adminActor(c)
    )
    return c.body(null, 204)
  }
)

export default router
