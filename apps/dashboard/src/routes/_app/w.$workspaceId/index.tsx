import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceScreen } from '~/features/workspaces/workspace-screen'
import { syncScope } from '~/state/scope'

export const Route = createFileRoute('/_app/w/$workspaceId/')({
  beforeLoad: ({ context, params }) =>
    syncScope(context.queryClient, {
      workspaceId: params.workspaceId,
      projectId: null,
      environmentId: null,
    }),
  // Keyed: the router keeps the component when only `$workspaceId` changes, and an open
  // dialog of one workspace must not be shown under another.
  component: () => {
    const { workspaceId } = Route.useParams()
    return <WorkspaceScreen key={workspaceId} workspaceId={workspaceId} />
  },
})
