import {
  ActivityTypeSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WEBHOOK_DELIVERY_STATES,
} from '@tula/contract'
import { z } from 'zod'
import { WEBHOOK_DELIVERY_LIST_WINDOW } from '~/modules/webhook/service'

export {
  CreatedWebhookEndpointSchema,
  CreateWebhookEndpointRequestSchema,
  RotatedWebhookSecretSchema,
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
  // The log is paged through its newest deliveries only: no offset over millions of rows.
  .refine((query) => query.page * query.size <= WEBHOOK_DELIVERY_LIST_WINDOW, {
    path: ['page'],
    message: `The delivery log is paged through its newest ${WEBHOOK_DELIVERY_LIST_WINDOW} deliveries. Narrow it with state or eventType.`,
  })
  .meta({ ref: 'WebhookDeliveryQuery' })
