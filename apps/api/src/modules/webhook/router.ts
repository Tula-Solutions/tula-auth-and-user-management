import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit, byEnvironment, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Webhooks from '~/modules/webhook/service'
import * as openapi from '~/openapi'
import {
  CreatedWebhookEndpointSchema,
  CreateWebhookEndpointRequestSchema,
  SendTestWebhookRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookDeliveryDetailSchema,
  WebhookDeliveryListSchema,
  WebhookDeliveryParamSchema,
  WebhookDeliveryQuerySchema,
  WebhookEndpointIdParamSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
  WebhookSendResultSchema,
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

/**
 * The limit on requests made on demand (a test event, a delivery sent again), per environment.
 * Mounted **after** `secretKey()`: it is counted by the environment the key resolved, so a
 * caller cannot get a fresh allowance by coming from another address. Each such request makes
 * the server call an address, which the general admin limit (300 a minute per IP) would let
 * an administrator do far too often. Refuses when the limiter cannot count.
 */
const sendRateLimit = rateLimit({
  name: 'webhook_send',
  limit: Webhooks.WEBHOOK_SEND_RATE_LIMIT,
  window: '1m',
  key: byEnvironment,
})

const onlyTheOutcome =
  'The answer is the outcome, the receiver’s status code and how long it took: nothing else ' +
  'of what the receiver said is read or kept. When there was no answer, `failureReason` is ' +
  'one of the server’s fixed words (`timeout`, `connection_failed`, `address_not_allowed`, …). ' +
  `Limited to ${Webhooks.WEBHOOK_SEND_RATE_LIMIT} such requests a minute per environment.`

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
      'that time are not sent later. Switching it on (also after the server switched it off: ' +
      'see `disabledReason`) forgets why it was off and since when it was failing; deliveries ' +
      'that were pending are tried again unless they are more than three days old. The ' +
      'signing secret cannot be changed here. Recorded in ' +
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

router.get(
  '/:id/deliveries',
  describeRoute({
    operationId: 'listWebhookDeliveries',
    tags: ['Webhooks'],
    summary: 'List an endpoint’s deliveries',
    description:
      'The deliveries of one endpoint, newest first: one per event it was owed, and one per ' +
      'test event. Each says where it stands (`pending`, `delivered`, `failed`), how many ' +
      'requests were made and how the latest ended. Filter by `state` and `eventType`. ' +
      'Deliveries are kept for 90 days.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'One page of deliveries.', content: json(WebhookDeliveryListSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', WebhookEndpointIdParamSchema, validationHook),
  validator('query', WebhookDeliveryQuerySchema, validationHook),
  async (c) => {
    const page = await Webhooks.listDeliveries(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      c.req.valid('query')
    )
    return c.json(WebhookDeliveryListSchema.parse(page))
  }
)

router.get(
  '/:id/deliveries/:deliveryId',
  describeRoute({
    operationId: 'getWebhookDelivery',
    tags: ['Webhooks'],
    summary: 'Get a delivery and its attempts',
    description:
      'One delivery with every request the server made for it, oldest first. An attempt is a ' +
      'time, a status code or one of the server’s fixed words, and a duration: never a header ' +
      'or a body of the receiver’s answer.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The delivery.', content: json(WebhookDeliveryDetailSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', WebhookDeliveryParamSchema, validationHook),
  async (c) => {
    const { id, deliveryId } = c.req.valid('param')
    const delivery = await Webhooks.getDelivery(c.get('deps'), c.get('tenant'), id, deliveryId)
    return c.json(WebhookDeliveryDetailSchema.parse(delivery))
  }
)

router.post(
  '/:id/test',
  describeRoute({
    operationId: 'sendTestWebhook',
    tags: ['Webhooks'],
    summary: 'Send a test event',
    description:
      'Sends one test event of the chosen type to the endpoint, now, signed like every ' +
      'delivery. The event is an example with a new id and **`"test": true`** inside the ' +
      'signed body, which no real event has: nothing it describes happened, and a receiver ' +
      'should check the field before acting. It is one request with no retry, recorded as a ' +
      'delivery flagged `test`; it is not written to the audit log and does not count ' +
      'towards switching the endpoint off. An endpoint that is off can be tested. ' +
      onlyTheOutcome,
    security: openapi.security.admin,
    responses: {
      200: { description: 'What became of the request.', content: json(WebhookSendResultSchema) },
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  sendRateLimit,
  validator('param', WebhookEndpointIdParamSchema, validationHook),
  validator('json', SendTestWebhookRequestSchema, validationHook),
  async (c) => {
    const result = await Webhooks.sendTest(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      c.req.valid('json')
    )
    return c.json(WebhookSendResultSchema.parse(result))
  }
)

router.post(
  '/:id/deliveries/:deliveryId/redeliver',
  describeRoute({
    operationId: 'redeliverWebhook',
    tags: ['Webhooks'],
    summary: 'Send a delivery again',
    description:
      'Makes one more request for a past delivery, now: the event’s stored payload, to the ' +
      'endpoint it was owed to, with the same `webhook-id` (a receiver that drops repeats by ' +
      'id will drop it). The request is added to the delivery’s own attempts. A 2xx makes ' +
      'the delivery `delivered`; a failure leaves it as it was and is not retried. Refused ' +
      'with `webhook.cannot_redeliver` (409) and a fixed word in `params.reason`: ' +
      '`delivery_pending` while the server is still retrying the delivery, ' +
      '`endpoint_disabled` for an endpoint that is switched off, and `event_gone` once the ' +
      'event is no longer kept (30 days) or for a test event. ' +
      onlyTheOutcome,
    security: openapi.security.admin,
    responses: {
      200: { description: 'What became of the request.', content: json(WebhookSendResultSchema) },
      409: openapi.responses[409],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  sendRateLimit,
  validator('param', WebhookDeliveryParamSchema, validationHook),
  async (c) => {
    const { id, deliveryId } = c.req.valid('param')
    const result = await Webhooks.redeliver(c.get('deps'), c.get('tenant'), id, deliveryId)
    return c.json(WebhookSendResultSchema.parse(result))
  }
)

export default router
