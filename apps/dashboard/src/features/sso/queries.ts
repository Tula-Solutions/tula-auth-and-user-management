import type { QueryClient } from '@tanstack/react-query'

/**
 * Ask again for every SSO connection query on screen (the generated keys are paths).
 *
 * @param queryClient - The app's query client.
 * @returns A promise that settles once they have been read again.
 */
export async function refreshSso(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' &&
      query.queryKey[0].startsWith('/v1/admin/sso-connections'),
  })
}
