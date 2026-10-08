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
  /**
   * Why the server switched it off; `null` while it is on and when an administrator did.
   */
  disabledReason: WebhookDisabledReason | null
  /**
   * When the current run of failed requests began: no success since, and no silence between
   * two failures longer than the service allows. `null` when the last request that was
   * answered succeeded. What "keeps failing" is measured from.
   */
  failingSince: Date | null
  /**
   * When a request to it last failed; `null` when the last one that was answered succeeded.
   * A failure long after this does not continue the run: it begins a new one.
   */
  lastFailedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** An endpoint's run of failed requests: both set while one is under way, both `null` otherwise. */
export interface WebhookEndpointHealth {
  failingSince: Date | null
  lastFailedAt: Date | null
}

/** Why the server switches an endpoint off by itself. */
export type WebhookDisabledReason = 'failing' | 'gone'

/** The fields of an endpoint an update may change. The secret and the id are not among them. */
export interface WebhookEndpointChanges {
  url?: string
  eventTypes?: string[]
  enabled?: boolean
  /**
   * Forget what the worker held against the endpoint (`failingSince`, `lastFailedAt`,
   * `disabledReason`): it is
   * being switched on again, or given another address.
   */
  resetHealth?: true
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

  /**
   * Write an endpoint's run of failures (when it began and when a request last failed, or
   * `null` for both), **only if the row still holds what the caller read**. The worker's own
   * bookkeeping: it changes nothing about who can do what and is **not recorded** (ADR 0012).
   * What it leads to, the endpoint being switched off, is ({@link WebhookEndpointStore.disable}).
   *
   * A compare-and-set, because the worker computes the new values from a row it read a while
   * ago. An administrator may have switched the endpoint on again or given it another address
   * since (both forget the run), or a delivery sent again may have got through: written
   * blindly, the worker's next failure would bring the forgotten run back, and could switch
   * off an endpoint that had just been reset. On `false` the caller reads the row again and
   * applies its rule to what is there now.
   *
   * `updatedAt` does not move: no administrator changed the endpoint.
   *
   * @param environmentId - The environment. An endpoint of another is not touched.
   * @param id - The endpoint.
   * @param expected - What the caller read: both values must still be exactly these. `null`
   *   writes over whatever is there, which is right for one case only: a request got through,
   *   and that ends any run.
   * @param next - The run as it stands now.
   * @returns `false` when nothing was written: the endpoint is gone, or its run is no longer
   *   what was read.
   */
  setHealth(
    environmentId: string,
    id: string,
    expected: WebhookEndpointHealth | null,
    next: WebhookEndpointHealth
  ): Promise<boolean>

  /**
   * Switch an endpoint off because of what its deliveries did, and say why.
   *
   * @param environmentId - The environment.
   * @param id - The endpoint.
   * @param reason - Why.
   * @param at - When.
   * @param activity - Recorded in the same transaction, only if the endpoint was on.
   * @returns `false` when the endpoint is gone or was already off: nothing changed.
   */
  disable(
    environmentId: string,
    id: string,
    reason: WebhookDisabledReason,
    at: Date,
    activity: Recorded
  ): Promise<boolean>
}
