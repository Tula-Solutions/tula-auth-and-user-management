import type { QueryClient } from '@tanstack/react-query'

/** The path every hook query's key begins with (the generated keys are paths). */
const HOOKS_PATH = '/v1/admin/hooks'

/**
 * Ask again for everything the hooks screen shows.
 *
 * @param queryClient - The app's query client.
 * @returns A promise that settles once every such query on screen has been read again. A
 *   caller that has something to show at once (a secret) starts it and does not wait.
 */
export async function refreshHooks(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith(HOOKS_PATH),
  })
}
