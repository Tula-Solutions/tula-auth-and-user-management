import { z } from 'zod'
import { ACTIVITY_TYPES } from './event-types'
import { PaginationMetaSchema } from './user'

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
    /**
     * Why the **server** switched the endpoint off: `failing` (every delivery failed for days)
     * or `gone` (it answered `410 Gone`). `null` while it is on, and when an administrator
     * switched it off. A plain string: a later server may know another reason.
     */
    disabledReason: z.string().nullable(),
    /**
     * Since when requests to the endpoint have kept failing: the first failure of the current
     * run, with no success since and no silence longer than the retry schedule. `null` when
     * the last request that got an answer succeeded. An endpoint whose run reaches five days
     * is switched off.
     */
    failingSince: z.iso.datetime().nullable(),
    /**
     * When a request to the endpoint last failed, or `null` when the last one that got an
     * answer succeeded. A failure after a long silence starts `failingSince` again.
     */
    lastFailedAt: z.iso.datetime().nullable(),
    /**
     * When the overlap of a secret rotation ends, which is when the endpoint's **previous**
     * signing secret stops signing. Set while an overlap is under way: until then every
     * delivery carries a signature for the current secret and one for the previous one.
     * `null` when one secret signs. A time and nothing else: no secret, and no part of one,
     * is ever returned by a read. (Named for the overlap and not for the secret on purpose:
     * nothing under a key that reads like a credential is ever a plain value.)
     */
    rotationOverlapEndsAt: z.iso.datetime().nullable(),
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

/**
 * An endpoint whose signing secret was just replaced. `secret` is the **new** secret
 * (`whsec_…`), in this response only. The previous secret is not returned (the receiver has
 * it); it keeps signing beside the new one until `rotationOverlapEndsAt`.
 */
export const RotatedWebhookSecretSchema = WebhookEndpointSchema.extend({
  secret: z.string().describe('The new signing secret. Store it now: it is shown only once.'),
  rotationOverlapEndsAt: z.iso
    .datetime()
    .describe(
      'When the previous secret stops signing. Until then deliveries carry both signatures.'
    ),
}).meta({ ref: 'RotatedWebhookSecret' })

/**
 * Why a signing secret cannot be replaced, or its overlap ended, as
 * `webhook.rotation_refused` says it in `params.reason`: a rotation is already under way (two
 * secrets sign, and there are never three), none is under way (there is no previous secret to
 * revoke), or the server could not open the endpoint's current secret and so cannot keep it
 * signing beside a new one.
 *
 * @example
 * ```ts
 * if (error.code === 'webhook.rotation_refused' && error.params?.reason === 'rotation_in_progress') {
 *   // wait for the overlap to end, or revoke the previous secret first
 * }
 * ```
 */
export const WEBHOOK_ROTATION_REFUSALS = [
  'rotation_in_progress',
  'no_rotation_in_progress',
  'secret_unreadable',
] as const

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

/**
 * Why a delivery cannot be sent again, as `webhook.cannot_redeliver` says it in
 * `params.reason`: the server is still retrying it, its endpoint is switched off, its
 * event's payload is no longer kept (also: it was a test event, which never had one), or it
 * has had as many requests as one delivery may have.
 *
 * @example
 * ```ts
 * if (error.code === 'webhook.cannot_redeliver' && error.params?.reason === 'event_gone') {
 *   // too late to send this one again
 * }
 * ```
 */
export const WEBHOOK_REDELIVER_REFUSALS = [
  'delivery_pending',
  'endpoint_disabled',
  'event_gone',
  'attempt_limit',
] as const

/**
 * Where a delivery stands: `pending` (not yet delivered, and the server will try, or try
 * again), `delivered` (the receiver answered 2xx) or `failed` (given up).
 *
 * @example
 * ```ts
 * const state: (typeof WEBHOOK_DELIVERY_STATES)[number] = 'pending'
 * ```
 */
export const WEBHOOK_DELIVERY_STATES = ['pending', 'delivered', 'failed'] as const

/**
 * One request the server made for a delivery. **Nothing of the receiver's answer is here but
 * its status code and how long it took**: no header and no body, which the server never keeps.
 */
export const WebhookDeliveryAttemptSchema = z
  .object({
    /** 1 for the first request of the delivery, counting up. */
    attempt: z.number().int().min(1),
    attemptedAt: z.iso.datetime(),
    /** The receiver's HTTP status; `null` when there was no answer. */
    statusCode: z.number().int().nullable(),
    /** Milliseconds from sending to the answer, or to giving up. */
    durationMs: z.number().int().min(0),
    /**
     * Why there was no answer: one of the server's own fixed words (`timeout`,
     * `connection_failed`, `address_not_allowed`, …). `null` when the receiver answered.
     */
    failureReason: z.string().nullable(),
  })
  .meta({ ref: 'WebhookDeliveryAttempt' })

/**
 * The delivery of one event to one endpoint: where it stands, and how its last try ended.
 *
 * `statusCode` and `failureReason` describe the latest thing that happened to it.
 * `failureReason` can be a word for which **no request was made** (`endpoint_unresponsive`,
 * `signing_failed`, `expired`, `event_gone`): those are not attempts and are not counted in
 * `attemptCount`.
 */
export const WebhookDeliverySchema = z
  .object({
    id: z.uuid(),
    endpointId: z.uuid(),
    /** The event's id, which is the delivery's `webhook-id`. `null` for a test event. */
    eventId: z.uuid().nullable(),
    /** The event's type. A plain string: a later server may record a type this one lacks. */
    eventType: z.string(),
    /** `true` for a test event an administrator asked for: nothing it describes happened. */
    test: z.boolean(),
    /** One of {@link WEBHOOK_DELIVERY_STATES} today. */
    state: z.string(),
    /** Requests made so far. */
    attemptCount: z.number().int().min(0),
    /** When the server tries next; `null` unless the delivery is `pending`. */
    nextAttemptAt: z.iso.datetime().nullable(),
    lastAttemptAt: z.iso.datetime().nullable(),
    statusCode: z.number().int().nullable(),
    failureReason: z.string().nullable(),
    /** When it was delivered or given up; `null` while `pending`. */
    completedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'WebhookDelivery' })

/** One delivery with every request made for it, oldest first. */
export const WebhookDeliveryDetailSchema = WebhookDeliverySchema.extend({
  attempts: z.array(WebhookDeliveryAttemptSchema),
}).meta({ ref: 'WebhookDeliveryDetail' })

/** One page of an endpoint's deliveries, newest first. */
export const WebhookDeliveryListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(WebhookDeliverySchema) })
  .meta({ ref: 'WebhookDeliveryList' })

/**
 * Body of `POST /v1/admin/webhook-endpoints/{id}/test`: the type of the example event to send.
 */
export const SendTestWebhookRequestSchema = z
  .strictObject({ eventType: z.enum(ACTIVITY_TYPES) })
  .meta({ ref: 'SendTestWebhookRequest' })

/**
 * What became of a request the server made on demand (a test event, or a delivery sent again).
 * Of the receiver's answer only the status code and the duration: never a header or a body.
 */
export const WebhookSendResultSchema = z
  .object({
    /** The delivery this request is recorded under. */
    deliveryId: z.uuid(),
    /** `delivered` when the receiver answered 2xx. */
    outcome: z.enum(['delivered', 'failed']),
    statusCode: z.number().int().nullable(),
    durationMs: z.number().int().min(0),
    /** One of the server's fixed words when there was no answer; otherwise `null`. */
    failureReason: z.string().nullable(),
  })
  .meta({ ref: 'WebhookSendResult' })

/** A listed webhook endpoint. */
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>
/** A newly registered webhook endpoint, with its signing secret. */
export type CreatedWebhookEndpoint = z.infer<typeof CreatedWebhookEndpointSchema>
/** An endpoint with its new signing secret, as a rotation answers. */
export type RotatedWebhookSecret = z.infer<typeof RotatedWebhookSecretSchema>
/** An environment's webhook endpoints. */
export type WebhookEndpointList = z.infer<typeof WebhookEndpointListSchema>
/** Create-endpoint request body. */
export type CreateWebhookEndpointRequest = z.infer<typeof CreateWebhookEndpointRequestSchema>
/** Update-endpoint request body. */
export type UpdateWebhookEndpointRequest = z.infer<typeof UpdateWebhookEndpointRequestSchema>
/** Where a delivery stands. */
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number]
/** One request made for a delivery. */
export type WebhookDeliveryAttempt = z.infer<typeof WebhookDeliveryAttemptSchema>
/** The delivery of one event to one endpoint. */
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>
/** A delivery with its attempts. */
export type WebhookDeliveryDetail = z.infer<typeof WebhookDeliveryDetailSchema>
/** A page of deliveries. */
export type WebhookDeliveryList = z.infer<typeof WebhookDeliveryListSchema>
/** Send-test-event request body. */
export type SendTestWebhookRequest = z.infer<typeof SendTestWebhookRequestSchema>
/** The outcome of a request made on demand. */
export type WebhookSendResult = z.infer<typeof WebhookSendResultSchema>
