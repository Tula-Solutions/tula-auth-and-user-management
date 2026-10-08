import { createFileRoute } from '@tanstack/react-router'
import { HomeScreen } from '~/features/workspaces/home-screen'
import { syncScope } from '~/state/scope'

export const Route = createFileRoute('/_app/')({
  beforeLoad: ({ context }) =>
    syncScope(context.queryClient, { workspaceId: null, projectId: null, environmentId: null }),
  component: HomeScreen,
})
