import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { getGetDashboardSessionQueryOptions } from '~/api/generated/api.gen'
import { AppShell } from '~/features/shell/app-shell'
import { useSession } from '~/state/session'

export const Route = createFileRoute('/_app')({
  // Every screen under the shell needs a session. The check is one request on the first
  // load; after that the store knows, and a 401 on any call flips it (the mutator).
  beforeLoad: async ({ context, location }) => {
    if (useSession.getState().status === 'signed_in') {
      return
    }
    try {
      const session = await context.queryClient.fetchQuery({
        ...getGetDashboardSessionQueryOptions(),
        retry: false,
        staleTime: 0,
      })
      useSession.getState().signedIn(session.expiresAt)
    } catch {
      throw redirect({ to: '/sign-in', search: { redirect: location.href }, replace: true })
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
})
