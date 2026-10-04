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
  component: () => <WorkspaceScreen workspaceId={Route.useParams().workspaceId} />,
})
