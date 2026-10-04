import { createFileRoute } from '@tanstack/react-router'
import { SignInMethodsScreen } from '~/features/settings/sign-in-methods-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/sign-in-methods'
)({
  component: SignInMethodsScreen,
})
