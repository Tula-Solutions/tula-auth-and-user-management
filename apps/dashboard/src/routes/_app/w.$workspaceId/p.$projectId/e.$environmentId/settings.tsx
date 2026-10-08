import { createFileRoute } from '@tanstack/react-router'
import { GeneralSettingsScreen } from '~/features/settings/general-settings-screen'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/settings')(
  {
    component: GeneralSettingsScreen,
  }
)
