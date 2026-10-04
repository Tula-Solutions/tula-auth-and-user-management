import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { toApiError } from '~/api/errors'
import { routeTree } from './routeTree.gen'

/** Where the API serves the app (ADR 0032); Vite's `base` is the same path. */
export const BASE_PATH = '/dashboard'

/**
 * The query client: answers stay fresh for a few seconds, and only a request that got no
 * answer is tried again (a refusal would be refused again).
 *
 * @returns A new client.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        retry: (failures, error) => failures < 1 && toApiError(error).code === 'network.failed',
      },
      mutations: { retry: false },
    },
  })
}

/**
 * Build the app's router.
 *
 * @param queryClient - The query client routes reach through their context.
 * @param history - A history to use instead of the browser's (tests).
 * @returns The router.
 */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    basepath: BASE_PATH,
    context: { queryClient },
    history,
    defaultPreload: false,
    // No scroll restoration: the router would keep its positions in sessionStorage, and this
    // app writes nothing to web storage at all.
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}

/**
 * The dashboard.
 *
 * @param props - `queryClient` and `router`, built once by the entry point.
 * @returns The app.
 */
export function App({
  queryClient,
  router,
}: {
  queryClient: QueryClient
  router: ReturnType<typeof createAppRouter>
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
