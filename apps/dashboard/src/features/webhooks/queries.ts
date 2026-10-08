import type { QueryClient } from '@tanstack/react-query'

/** The path every webhook query's key begins with (the generated keys are paths). */
const WEBHOOKS_PATH = '/v1/admin/webhook-endpoints'

/**
 * Ask again for everything the webhooks screens show: the endpoints, each endpoint, its
 * deliveries and each delivery. One change touches several of them (a delivery sent again
 * moves the delivery, its list and the endpoint's health), and none is expensive to read.
 *
 * @param queryClient - The app's query client.
 */
export async function refreshWebhooks(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith(WEBHOOKS_PATH),
  })
}
