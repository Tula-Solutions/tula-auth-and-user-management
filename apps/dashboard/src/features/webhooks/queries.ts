import type { QueryClient } from '@tanstack/react-query'

/** The path every webhook query's key begins with (the generated keys are paths). */
const WEBHOOKS_PATH = '/v1/admin/webhook-endpoints'

/**
 * Drop what is cached about one endpoint that no longer exists (itself, its deliveries), so
 * that the refresh after a deletion does not ask the server for it once more.
 *
 * @param queryClient - The app's query client.
 * @param endpointId - The deleted endpoint.
 */
export function forgetEndpoint(queryClient: QueryClient, endpointId: string): void {
  const own = `${WEBHOOKS_PATH}/${endpointId}`
  queryClient.removeQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith(own),
  })
}

/**
 * Ask again for everything the webhooks screens show: the endpoints, each endpoint, its
 * deliveries and each delivery. One change touches several of them (a delivery sent again
 * moves the delivery, its list and the endpoint's health), and none is expensive to read.
 *
 * @param queryClient - The app's query client.
 * @returns A promise that settles once every such query on screen has been read again. A
 *   caller that has something to show at once (a secret, a closed confirmation) starts it
 *   and does not wait.
 */
export async function refreshWebhooks(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith(WEBHOOKS_PATH),
  })
}
