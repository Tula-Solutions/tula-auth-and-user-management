import { boolean, text } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantParentKey } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * Where an environment's events are delivered (ADR 0034): an address an operator registered,
 * the event types it subscribed to, and the secret its deliveries are signed with.
 *
 * `secret` is the Standard Webhooks signing secret (`whsec_…`) sealed with AES-256-GCM under
 * `TULA_MASTER_KEY` and bound to the environment and the endpoint's id, so a ciphertext copied
 * to another row does not open. It has to be recoverable (the server signs with it), which is
 * why it is sealed rather than hashed. It is returned once, when the endpoint is created, and
 * by no API afterwards.
 *
 * `event_types` holds names from the contract's `ACTIVITY_TYPES`; the API validates them, the
 * database does not know the list.
 */
export const webhookEndpoints = tula.table(
  'webhook_endpoints',
  {
    id: primaryKey(),
    ...tenantColumns(),
    url: text('url').notNull(),
    eventTypes: text('event_types').array().notNull(),
    secret: text('secret').notNull(),
    /** Nothing is delivered to an endpoint while this is off. */
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [tenantParentKey('webhook_endpoints', t), ...tenantConstraints('webhook_endpoints', t)]
)

/** A webhook endpoint row. */
export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect
/** Insert shape for a webhook endpoint. */
export type NewWebhookEndpointRow = typeof webhookEndpoints.$inferInsert
