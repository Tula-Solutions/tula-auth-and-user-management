import { createFileRoute } from '@tanstack/react-router'
import { NativeAppsScreen } from '~/features/native-apps/native-apps-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/native-apps'
)({
  component: NativeAppsScreen,
})
