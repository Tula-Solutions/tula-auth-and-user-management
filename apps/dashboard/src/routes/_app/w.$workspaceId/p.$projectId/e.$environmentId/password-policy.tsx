import { createFileRoute } from '@tanstack/react-router'
import { PasswordPolicyScreen } from '~/features/settings/password-policy-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/password-policy'
)({
  component: PasswordPolicyScreen,
})
