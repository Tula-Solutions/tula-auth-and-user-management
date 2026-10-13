import { createFileRoute } from '@tanstack/react-router'
import { HooksScreen } from '~/features/hooks/hooks-screen'

export const Route = createFileRoute('/_app/w/$workspaceId/p/$projectId/e/$environmentId/hooks')({
  component: HooksScreen,
})
