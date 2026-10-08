import type { Recorded } from '~/ports/activity-log'

/** A webhook endpoint as stored (ADR 0034). */
export interface WebhookEndpointRecord {
  id: string
  projectId: string
  environmentId: string
  /** Where events are posted. Judged by the outbound guard when saved and at every delivery. */
  url: string
  /** Names from the contract's `ACTIVITY_TYPES`. */
  eventTypes: string[]
  /**
   * The signing secret, sealed (`~/lib/secret-box`, bound to environment and endpoint id).
   * Never leaves the API after the response that created the endpoint.
   */
  secret: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

/** The fields of an endpoint an update may change. The secret and the id are not among them. */
export interface WebhookEndpointChanges {
  url?: string
  eventTypes?: string[]
  enabled?: boolean
}

/** Webhook endpoints, always read and written inside one environment. */
export interface WebhookEndpointStore {
  /**
   * @param environmentId - The environment to look in.
   * @returns Its endpoints, oldest first.
   */
  list(environmentId: string): Promise<WebhookEndpointRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param id - The endpoint.
   * @returns The endpoint, or `null` when the environment has none with that id.
   */
  find(environmentId: string, id: string): Promise<WebhookEndpointRecord | null>

  /**
   * Store a new endpoint.
   *
   * @param record - The endpoint, its secret already sealed.
   * @param activity - Recorded in the same transaction.
   * @returns The row as stored.
   */
  insert(record: WebhookEndpointRecord, activity: Recorded): Promise<WebhookEndpointRecord>

  /**
   * Change an endpoint.
   *
   * @param environmentId - The environment.
   * @param id - The endpoint.
   * @param changes - The fields to set; one left out keeps its value.
   * @param updatedAt - When the change is made.
   * @param activity - Recorded in the same transaction, only if the endpoint exists.
   * @returns The endpoint as it is now, or `null` when the environment has none with that id.
   */
  update(
    environmentId: string,
    id: string,
    changes: WebhookEndpointChanges,
    updatedAt: Date,
    activity: Recorded
  ): Promise<WebhookEndpointRecord | null>

  /**
   * Remove an endpoint, and with it the record of its deliveries.
   *
   * @param environmentId - The environment.
   * @param id - The endpoint.
   * @param activity - Recorded in the same transaction, only if something was removed.
   * @returns `false` when the environment has no endpoint with that id.
   */
  delete(environmentId: string, id: string, activity: Recorded): Promise<boolean>
}
