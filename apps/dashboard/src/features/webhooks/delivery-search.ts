import { ActivityType, WebhookDeliveryQueryState } from '~/api/generated/api.gen'
import { pageSearch } from '~/lib/search'

// Read by a route's `validateSearch`, which is part of the entry chunk and not of the
// route's lazily loaded one. So this module imports nothing that builds a Zod schema when it
// loads: the entry chunk's imports run before `lib/zod-csp.ts` has switched Zod's
// `new Function` probe off, and a schema built then is a Content-Security-Policy violation
// (the browser tests fail on it). The lists come from the generated client, which is plain
// data made from the same contract.

/** The delivery list's filters and page, as the address holds them. */
export interface DeliveryFilters {
  /** One of the contract's delivery states. */
  state?: WebhookDeliveryQueryState
  /** One of the contract's event types. */
  eventType?: ActivityType
  page?: number
}

function isOneOf<T extends string>(values: Record<string, T>, value: unknown): value is T {
  return typeof value === 'string' && Object.values<string>(values).includes(value)
}

/**
 * Read the delivery list's filters from a route's search parameters. A state or a type the
 * contract does not know is left out, so a hand-edited address cannot produce a refused
 * request; the first page is no page.
 *
 * @param search - The raw search parameters.
 * @returns The filters.
 */
export function deliverySearch(search: Record<string, unknown>): DeliveryFilters {
  return {
    ...(isOneOf(WebhookDeliveryQueryState, search.state) ? { state: search.state } : {}),
    ...(isOneOf(ActivityType, search.eventType) ? { eventType: search.eventType } : {}),
    ...pageSearch(search),
  }
}
