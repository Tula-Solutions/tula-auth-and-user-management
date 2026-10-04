import { createFileRoute } from '@tanstack/react-router'
import { ApiKeysScreen } from '~/features/keys/api-keys-screen'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/api-keys')(
  {
    component: ApiKeysScreen,
  }
)
