import { createFileRoute, Outlet } from '@tanstack/react-router'
import { EnvironmentGate } from '~/features/shell/environment-gate'
import { syncScope } from '~/state/scope'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId')({
  // The store mirrors the address before anything below renders or fetches: admin calls take
  // their environment from it.
  beforeLoad: ({ context, params }) => syncScope(context.queryClient, params),
  component: () => {
    const { projectId, environmentId } = Route.useParams()
    return (
      <EnvironmentGate projectId={projectId} environmentId={environmentId}>
        <Outlet />
      </EnvironmentGate>
    )
  },
})
