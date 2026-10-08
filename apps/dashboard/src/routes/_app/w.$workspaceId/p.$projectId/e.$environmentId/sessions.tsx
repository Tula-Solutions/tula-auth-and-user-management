import { createFileRoute } from '@tanstack/react-router'
import { SessionProfilesScreen } from '~/features/settings/session-profiles-screen'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/sessions')(
  {
    component: SessionProfilesScreen,
  }
)
