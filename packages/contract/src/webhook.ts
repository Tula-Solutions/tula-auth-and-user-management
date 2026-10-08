import { z } from 'zod'
import { ACTIVITY_TYPES } from './event-types'

// The admin API's view of a webhook endpoint (ADR 0034): where an environment's events are
// delivered, signed. How a delivery is signed is in the Zod-free `./webhook-signature`.

/**
 * Longest address of a webhook endpoint.
 *
 * @example
 * ```ts
 * url.length <= MAX_WEBHOOK_URL_LENGTH
 * ```
 */
export const MAX_WEBHOOK_URL_LENGTH = 2048

/**
 * Most webhook endpoints one environment may have. Every event is sent to each endpoint that
 * subscribed to its type, so the number of endpoints bounds the requests one event causes.
 *
 * @example
 * ```ts
 * if (endpoints.length >= MAX_WEBHOOK_ENDPOINTS) {
 *   // remove one first
 * }
 * ```
 */
export const MAX_WEBHOOK_ENDPOINTS = 10

/**
 * An endpoint's address as typed: bounded here, judged by the server's outbound guard.
 *
 * No white space and no control character: a URL parser drops a tab or a line break from the
 * middle of an address, so one that held any would not be the address that is called.
 */
const url = () =>
  z
    .string()
    .min(1)
    .max(MAX_WEBHOOK_URL_LENGTH)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
    .regex(/^[^\s\u0000-\u001f\u007f]+$/, 'Must not contain spaces or control characters.')

/** The event types an endpoint subscribes to: one or more known types, each once. */
const eventTypes = () =>
  z
    .array(z.enum(ACTIVITY_TYPES))
    .min(1)
    .max(ACTIVITY_TYPES.length)
    .refine((types) => new Set(types).size === types.length, {
      message: 'An event type is listed more than once.',
    })

/**
 * A webhook endpoint as listed. The signing secret is never part of it: it is returned once,
 * by the call that created the endpoint.
 */
export const WebhookEndpointSchema = z
  .object({
    id: z.uuid(),
    /** Where events are posted. */
    url: z.string(),
    /**
     * The event types delivered to it. Plain strings, so a client built against this version
     * keeps reading a list a later server wrote.
     */
    eventTypes: z.array(z.string()),
    /** Nothing is delivered while this is off; events from that time are not sent later. */
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'WebhookEndpoint' })

/**
 * A newly registered endpoint. `secret` is its signing secret (`whsec_…`), in this response
 * only: the server keeps it sealed and never returns it again.
 */
export const CreatedWebhookEndpointSchema = WebhookEndpointSchema.extend({
  secret: z.string().describe('The signing secret. Store it now: it is shown only once.'),
}).meta({ ref: 'CreatedWebhookEndpoint' })

/** An environment's webhook endpoints, oldest first. */
export const WebhookEndpointListSchema = z
  .object({ data: z.array(WebhookEndpointSchema) })
  .meta({ ref: 'WebhookEndpointList' })

/**
 * Body of `POST /v1/admin/webhook-endpoints`.
 *
 * `url` must be one the server may call: `https`, no credentials, and a host that resolves to
 * public addresses only (`webhook.url_not_allowed` otherwise). There is no `secret` field: the
 * server generates it.
 */
export const CreateWebhookEndpointRequestSchema = z
  .strictObject({
    url: url(),
    eventTypes: eventTypes(),
    enabled: z.boolean().default(true),
  })
  .meta({ ref: 'CreateWebhookEndpointRequest' })

/** Body of `PATCH /v1/admin/webhook-endpoints/{id}`: the fields to change, at least one. */
export const UpdateWebhookEndpointRequestSchema = z
  .strictObject({
    url: url().optional(),
    eventTypes: eventTypes().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: 'Name at least one field to change.',
  })
  .meta({ ref: 'UpdateWebhookEndpointRequest' })

/** A listed webhook endpoint. */
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>
/** A newly registered webhook endpoint, with its signing secret. */
export type CreatedWebhookEndpoint = z.infer<typeof CreatedWebhookEndpointSchema>
/** An environment's webhook endpoints. */
export type WebhookEndpointList = z.infer<typeof WebhookEndpointListSchema>
/** Create-endpoint request body. */
export type CreateWebhookEndpointRequest = z.infer<typeof CreateWebhookEndpointRequestSchema>
/** Update-endpoint request body. */
export type UpdateWebhookEndpointRequest = z.infer<typeof UpdateWebhookEndpointRequestSchema>
