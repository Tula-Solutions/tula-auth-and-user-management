import { createFileRoute } from '@tanstack/react-router'
import { ProjectScreen } from '~/features/workspaces/project-screen'
import { syncScope } from '~/state/scope'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/')({
  beforeLoad: ({ context, params }) =>
    syncScope(context.queryClient, { ...params, environmentId: null }),
  component: () => <ProjectScreen {...Route.useParams()} />,
})
