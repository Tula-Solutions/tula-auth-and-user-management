import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Webhooks from '~/modules/webhook/service'
import * as openapi from '~/openapi'
import {
  CreatedWebhookEndpointSchema,
  CreateWebhookEndpointRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookEndpointIdParamSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
} from './schema'

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

const refusedAddress =
  'An address the server may not call is refused with `webhook.url_not_allowed` (422): it must ' +
  'be `https`, carry no credentials, and its host must resolve to public addresses only. ' +
  '`params.reason` is a fixed word for the rule that refused it, never the address.'

router.get(
  '/',
  describeRoute({
    operationId: 'listWebhookEndpoints',
    tags: ['Webhooks'],
    summary: 'List webhook endpoints',
    description:
      'The environment’s webhook endpoints, oldest first. A signing secret is never returned ' +
      'here: it is shown once, when its endpoint is created.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The endpoints.', content: json(WebhookEndpointListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await Webhooks.list(c.get('deps'), c.get('tenant'))
    return c.json(WebhookEndpointListSchema.parse({ data }))
  }
)

router.post(
  '/',
  describeRoute({
    operationId: 'createWebhookEndpoint',
    tags: ['Webhooks'],
    summary: 'Register a webhook endpoint',
    description:
      'Registers an address that events of the given types are delivered to, signed ' +
      '(Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`). The server ' +
      'generates the signing secret (`whsec_…`) and returns it in this response only; it is ' +
      'stored encrypted and cannot be read again. Events that happened before the endpoint ' +
      `was registered are not sent to it. ${refusedAddress}`,
    security: openapi.security.admin,
    responses: {
      201: {
        description: 'The new endpoint, including its signing secret.',
        content: json(CreatedWebhookEndpointSchema),
      },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', CreateWebhookEndpointRequestSchema, validationHook),
  async (c) => {
    const created = await Webhooks.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      adminActor(c)
    )
    // Never let an intermediary cache the one response that contains the secret.
    c.header('Cache-Control', 'no-store')
    return c.json(CreatedWebhookEndpointSchema.parse(created), 201)
  }
)

router.get(
  '/:id',
  describeRoute({
    operationId: 'getWebhookEndpoint',
    tags: ['Webhooks'],
    summary: 'Get a webhook endpoint',
    description: 'One webhook endpoint of the environment. Never its signing secret.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The endpoint.', content: json(WebhookEndpointSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', WebhookEndpointIdParamSchema, validationHook),
  async (c) => {
    const endpoint = await Webhooks.get(c.get('deps'), c.get('tenant'), c.req.valid('param').id)
    return c.json(WebhookEndpointSchema.parse(endpoint))
  }
)

router.patch(
  '/:id',
  describeRoute({
    operationId: 'updateWebhookEndpoint',
    tags: ['Webhooks'],
    summary: 'Change a webhook endpoint',
    description:
      'Changes the address, the event types or whether the endpoint is on; a field left out ' +
      'keeps its value. While an endpoint is off nothing is delivered to it, and the events of ' +
      'that time are not sent later. The signing secret cannot be changed here. Recorded in ' +
      `the audit log by the names of the fields that changed, never their values. ${refusedAddress}`,
    security: openapi.security.admin,
    responses: {
      200: { description: 'The endpoint as it is now.', content: json(WebhookEndpointSchema) },
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', WebhookEndpointIdParamSchema, validationHook),
  validator('json', UpdateWebhookEndpointRequestSchema, validationHook),
  async (c) => {
    const updated = await Webhooks.update(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      c.req.valid('json'),
      adminActor(c)
    )
    return c.json(WebhookEndpointSchema.parse(updated))
  }
)

router.delete(
  '/:id',
  describeRoute({
    operationId: 'deleteWebhookEndpoint',
    tags: ['Webhooks'],
    summary: 'Remove a webhook endpoint',
    description:
      'Removes the endpoint: nothing more is delivered to it, and its signing secret and the ' +
      'record of its deliveries are deleted with it.',
    security: openapi.security.admin,
    responses: {
      204: { description: 'Removed.' },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', WebhookEndpointIdParamSchema, validationHook),
  async (c) => {
    await Webhooks.remove(c.get('deps'), c.get('tenant'), c.req.valid('param').id, adminActor(c))
    return c.body(null, 204)
  }
)

export default router
