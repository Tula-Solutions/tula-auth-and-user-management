import { createFileRoute } from '@tanstack/react-router'
import { RolesScreen } from '~/features/organizations/roles-screen'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/roles')({
  component: RolesScreen,
})
