import { PageHeader } from '~/components/page'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { pageSearch } from '~/lib/search'

/** The delivery list's filters and page, as the address holds them. */
export interface DeliveryFilters {
  state?: string
  eventType?: string
  page?: number
}

/**
 * Read the delivery list's filters from a route's search parameters.
 *
 * @param search - The raw search parameters.
 * @returns The filters.
 */
export function deliverySearch(search: Record<string, unknown>): DeliveryFilters {
  return { ...pageSearch(search) }
}

/** Props of {@link WebhookEndpointScreen}. */
export interface WebhookEndpointScreenProps {
  scope: EnvironmentScope
  endpointId: string
  filters: DeliveryFilters
  onFilters: (filters: DeliveryFilters) => void
  onGone: () => void
}

/**
 * One webhook endpoint and its deliveries.
 *
 * @param _props - See {@link WebhookEndpointScreenProps}.
 * @returns The screen.
 */
export function WebhookEndpointScreen(_props: WebhookEndpointScreenProps) {
  return <PageHeader title='Webhook endpoint' />
}
