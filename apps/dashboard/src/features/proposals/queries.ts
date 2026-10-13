import type { QueryClient } from '@tanstack/react-query'

/** The path every proposal query's key begins with (the generated keys are paths). */
const PROPOSALS_PATH = '/v1/admin/proposals'

/**
 * Ask again for everything the proposals screen lists.
 *
 * @param queryClient - The app's query client.
 * @returns A promise that settles once every such query on screen has been read again.
 */
export async function refreshProposals(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith(PROPOSALS_PATH),
  })
}
