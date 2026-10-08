import {
  ActivityTypeSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WEBHOOK_DELIVERY_STATES,
} from '@tula/contract'
import { z } from 'zod'

export {
  CreatedWebhookEndpointSchema,
  CreateWebhookEndpointRequestSchema,
  SendTestWebhookRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookDeliveryDetailSchema,
  WebhookDeliveryListSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
  WebhookSendResultSchema,
} from '@tula/contract'

/** The webhook endpoint named in a path. */
export const WebhookEndpointIdParamSchema = z.object({ id: z.uuid() })

/** A delivery of a webhook endpoint, both named in a path. */
export const WebhookDeliveryParamSchema = z.object({ id: z.uuid(), deliveryId: z.uuid() })

/** Query parameters of an endpoint's delivery log: filters and paging. */
export const WebhookDeliveryQuerySchema = z
  .object({
    /** Only deliveries in this state. */
    state: z.enum(WEBHOOK_DELIVERY_STATES).optional(),
    /** Only deliveries of this event type. */
    eventType: ActivityTypeSchema.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .meta({ ref: 'WebhookDeliveryQuery' })
