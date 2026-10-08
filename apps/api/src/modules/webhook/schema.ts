import { z } from 'zod'

export {
  CreatedWebhookEndpointSchema,
  CreateWebhookEndpointRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
} from '@tula/contract'

/** The webhook endpoint named in a path. */
export const WebhookEndpointIdParamSchema = z.object({ id: z.uuid() })
