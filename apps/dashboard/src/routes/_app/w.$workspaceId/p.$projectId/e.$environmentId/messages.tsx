import { createFileRoute } from '@tanstack/react-router'
import { MessagesScreen } from '~/features/messages/messages-screen'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/messages')(
  {
    component: MessagesScreen,
  }
)
