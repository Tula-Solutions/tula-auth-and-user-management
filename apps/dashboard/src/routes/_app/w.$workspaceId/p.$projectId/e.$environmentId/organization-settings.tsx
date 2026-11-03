import { createFileRoute } from '@tanstack/react-router'
import { OrganizationSettingsScreen } from '~/features/organizations/organization-settings-screen'

export const Route = createFileRoute(
  '/_app/w/$workspaceId/p/$projectId/e/$environmentId/organization-settings'
)({
  component: OrganizationSettingsScreen,
})
