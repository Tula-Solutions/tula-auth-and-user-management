import { ActivityType, WebhookDeliveryQueryState } from '~/api/generated/api.gen'
import { pageSearch } from '~/lib/search'

// Read by a route's `validateSearch`, which is part of the entry chunk and not of the
// route's lazily loaded one. So this module imports nothing that builds a Zod schema when it
// loads: the entry chunk's imports run before `lib/zod-csp.ts` has switched Zod's probe for
// `eval` off, and a schema built then is a Content-Security-Policy violation (the browser
// tests fail on it; `words.test.ts` walks this module's imports and fails for one that
// reaches `zod` or the contract's schemas). The lists come from the generated client, which
// is plain data made from the same contract.

/**
 * How many deliveries one page of the list holds: the API's default page size
 * (`DEFAULT_PAGE_SIZE` in the contract, which this module cannot import; a test holds the
 * two equal).
 */
export const DELIVERY_PAGE_SIZE = 20

/**
 * How far into an endpoint's delivery log the API pages: its newest 10,000 deliveries
 * (`WEBHOOK_DELIVERY_LIST_WINDOW` in `apps/api/src/modules/webhook/service.ts`). A page
 * past it is refused with `validation.failed`. The number is not in the contract; the
 * operation's description states it, and a test reads it from the generated client and
 * holds this constant to it.
 */
export const DELIVERY_LIST_WINDOW = 10_000

/** The last page of {@link DELIVERY_PAGE_SIZE} deliveries inside {@link DELIVERY_LIST_WINDOW}. */
export const LAST_DELIVERY_PAGE = Math.floor(DELIVERY_LIST_WINDOW / DELIVERY_PAGE_SIZE)

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
 * contract does not know, and a page the server would refuse (one past
 * {@link LAST_DELIVERY_PAGE}), is left out, so a hand-edited address cannot produce a refused
 * request; the first page is no page. A page inside the window that the list does not have
 * is not refused: the server answers it with no rows.
 *
 * @param search - The raw search parameters.
 * @returns The filters.
 */
export function deliverySearch(search: Record<string, unknown>): DeliveryFilters {
  const { page } = pageSearch(search)
  return {
    ...(isOneOf(WebhookDeliveryQueryState, search.state) ? { state: search.state } : {}),
    ...(isOneOf(ActivityType, search.eventType) ? { eventType: search.eventType } : {}),
    ...(page !== undefined && page <= LAST_DELIVERY_PAGE ? { page } : {}),
  }
}
