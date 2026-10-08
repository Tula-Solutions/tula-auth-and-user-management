import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { ErrorState } from '~/components/states'
import { Toaster } from '~/components/toaster'

/** What every route can reach through the router. */
export interface RouterContext {
  queryClient: QueryClient
}

function NotFound() {
  return (
    <div className='flex flex-col items-start gap-3 p-6'>
      <h1 className='text-2xl font-semibold'>Page not found</h1>
      <p className='text-sm text-muted-foreground'>There is nothing at this address.</p>
      <Link to='/' className='text-link underline underline-offset-4'>
        Go to the dashboard
      </Link>
    </div>
  )
}

/**
 * What a route that threw is replaced with: the message and a retry, never a blank page.
 *
 * @param props - The router's error and its `reset`.
 * @returns The error state.
 */
export function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  return (
    <div className='p-6'>
      <ErrorState error={error} onRetry={reset} />
    </div>
  )
}

function Root() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
})
