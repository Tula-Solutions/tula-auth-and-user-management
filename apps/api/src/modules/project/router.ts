import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Project from '~/modules/project/service'
import * as openapi from '~/openapi'
import {
  ApiKeyIdParamSchema,
  ApiKeyListSchema,
  ApiKeySchema,
  CreateApiKeyRequestSchema,
  CreatedApiKeySchema,
  EnvironmentListSchema,
} from './schema'

const router = new Hono<AppEnv>()

// Middleware is attached per route, not with `router.use('*')`: this router is mounted at
// `/v1/admin`, and a wildcard would also run for every other admin module under that prefix.
const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

router.get(
  '/environments',
  describeRoute({
    operationId: 'listEnvironments',
    tags: ['Project'],
    summary: 'List environments',
    description: 'The environments of the project the secret key belongs to.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The environments.', content: json(EnvironmentListSchema) },
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await Project.listEnvironments(c.get('deps'), c.get('tenant'))
    return c.json(EnvironmentListSchema.parse({ data }))
  }
)

router.get(
  '/api-keys',
  describeRoute({
    operationId: 'listApiKeys',
    tags: ['Project'],
    summary: 'List API keys',
    description:
      'API keys of the secret key’s environment, newest first. Key values are never returned.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The keys.', content: json(ApiKeyListSchema) },
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await Project.listApiKeys(c.get('deps'), c.get('tenant'))
    return c.json(ApiKeyListSchema.parse({ data }))
  }
)

router.post(
  '/api-keys',
  describeRoute({
    operationId: 'createApiKey',
    tags: ['Project'],
    summary: 'Create an API key',
    description:
      'Creates a key in the secret key’s environment. The full key is in this response only.',
    security: openapi.security.admin,
    responses: {
      413: openapi.responses[413],
      201: { description: 'The new key, including its value.', content: json(CreatedApiKeySchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateApiKeyRequestSchema, validationHook),
  async (c) => {
    const created = await Project.createApiKey(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    // Never let an intermediary cache the one response that contains the key.
    c.header('Cache-Control', 'no-store')
    return c.json(CreatedApiKeySchema.parse(created), 201)
  }
)

router.delete(
  '/api-keys/:id',
  describeRoute({
    operationId: 'revokeApiKey',
    tags: ['Project'],
    summary: 'Revoke an API key',
    description:
      'Revokes a key in the secret key’s environment. Idempotent. A key cannot revoke itself.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The revoked key.', content: json(ApiKeySchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', ApiKeyIdParamSchema, validationHook),
  async (c) => {
    const revoked = await Project.revokeApiKey(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      adminActor(c)
    )
    return c.json(ApiKeySchema.parse(revoked))
  }
)

export default router
