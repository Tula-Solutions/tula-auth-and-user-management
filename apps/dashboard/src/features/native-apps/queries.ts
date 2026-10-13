import type { QueryClient } from '@tanstack/react-query'

/** The path every native app query's key begins with (the generated keys are paths). */
const NATIVE_APPS_PATH = '/v1/admin/native-apps'

/**
 * Ask again for everything the native apps screen shows.
 *
 * @param queryClient - The app's query client.
 * @returns A promise that settles once every such query on screen has been read again.
 */
export async function refreshNativeApps(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith(NATIVE_APPS_PATH),
  })
}
